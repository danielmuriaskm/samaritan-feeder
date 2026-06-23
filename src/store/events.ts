import { query, one, exec } from '../db.js';
import type { EventKind, IntelligenceEvent } from '../types.js';
import { createHash } from 'crypto';

export async function listEvents(opts: {
  sourceId?: string;
  kinds?: EventKind[];
  since?: number;
  until?: number;
  near?: { lat: number; lon: number; radiusKm: number };
  limit?: number;
  offset?: number;
}): Promise<IntelligenceEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }
  if (opts.until) { conditions.push(`event_at <= $${idx++}`); params.push(opts.until); }
  if (opts.near) {
    conditions.push(`location_lat IS NOT NULL AND location_lon IS NOT NULL`);
    // PostgreSQL doesn't have native geo distance without PostGIS, so we use a bounding box approximation
    const latDelta = opts.near.radiusKm / 111.32;
    const lonDelta = opts.near.radiusKm / (111.32 * Math.cos((opts.near.lat * Math.PI) / 180));
    conditions.push(`location_lat BETWEEN $${idx} AND $${idx + 1}`);
    params.push(opts.near.lat - latDelta, opts.near.lat + latDelta);
    idx += 2;
    conditions.push(`location_lon BETWEEN $${idx} AND $${idx + 1}`);
    params.push(opts.near.lon - lonDelta, opts.near.lon + lonDelta);
    idx += 2;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = typeof opts.limit === 'number' ? opts.limit : 50;
  const offset = typeof opts.offset === 'number' ? opts.offset : 0;

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_events ${where} ORDER BY event_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  );
  return rows.map(fromRow);
}

/**
 * Like listEvents, but collapses items that share a title to the most recent one
 * (DISTINCT ON lower(trim(title)), latest event_at). Null/empty titles are never
 * collapsed (keyed by id). This is the read path for the Events feed: over-producing
 * sources (e.g. the NWS seeds re-emitting the same warning every poll, ~1.5k/day)
 * would otherwise flood it with near-identical rows. Supports the feed UI's filters:
 * free-text q (ILIKE title/content), sourceId, kinds, since.
 */
export async function listEventsDeduped(opts: {
  query?: string;
  sourceId?: string;
  kinds?: EventKind[];
  since?: number;
  limit?: number;
}): Promise<IntelligenceEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.query) {
    conditions.push(`(content ILIKE $${idx} OR title ILIKE $${idx})`);
    params.push(`%${opts.query}%`);
    idx++;
  }
  if (opts.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = typeof opts.limit === 'number' ? Math.min(Math.max(1, opts.limit), 500) : 150;

  // DISTINCT ON the title key keeps the newest row per title; survivors are then
  // ordered by recency and capped. The dedupe key falls back to the id for rows
  // with no usable title so genuinely distinct untitled events are preserved.
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM (
       SELECT DISTINCT ON (COALESCE(NULLIF(lower(btrim(title)), ''), id::text)) *
         FROM intelligence_events ${where}
        ORDER BY COALESCE(NULLIF(lower(btrim(title)), ''), id::text), event_at DESC
     ) d
     ORDER BY event_at DESC
     LIMIT $${idx++}`,
    [...params, limit],
  );
  return rows.map(fromRow);
}

export async function searchEvents(opts: {
  query?: string;
  sourceId?: string;
  kinds?: EventKind[];
  since?: number;
  limit?: number;
}): Promise<IntelligenceEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.query) {
    conditions.push(`(content ILIKE $${idx} OR title ILIKE $${idx})`);
    params.push(`%${opts.query}%`);
    idx++;
  }
  if (opts.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_events ${where} ORDER BY event_at DESC LIMIT $${idx++}`,
    [...params, opts.limit ?? 20],
  );
  return rows.map(fromRow);
}

/**
 * Top events by composite importance score ("most important first"), not recency.
 * Falls back to `confidence` for rows not yet scored. The keystone read path for
 * the dashboard, MCP `top_intelligence` tool, and digest ranking.
 */
export async function listTopEvents(opts: {
  since?: number;
  kinds?: EventKind[];
  sourceId?: string;
  minScore?: number;
  limit?: number;
}): Promise<IntelligenceEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (typeof opts.minScore === 'number') { conditions.push(`COALESCE(score, confidence) >= $${idx++}`); params.push(opts.minScore); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_events ${where}
     ORDER BY COALESCE(score, confidence) DESC, event_at DESC LIMIT $${idx++}`,
    [...params, opts.limit ?? 20],
  );
  return rows.map(fromRow);
}

/**
 * Nearest text events to a query embedding via the cosine distance pgvector
 * operator on `vector_v`. Embeddings are stored as `real[]`; we cast to `vector`
 * at query time so the optional pgvector extension is only required when this is
 * actually called. Returns [] (not throw) when pgvector/operator is unavailable
 * so the ILIKE path can remain the default.
 */
export async function searchEventsByVector(
  queryEmbedding: number[],
  opts: { since?: number; kinds?: EventKind[]; limit?: number } = {},
): Promise<Array<IntelligenceEvent & { distance: number }>> {
  if (!queryEmbedding.length) return [];
  const literal = `[${queryEmbedding.join(',')}]`;
  const conditions: string[] = ['vector_v IS NOT NULL'];
  const params: unknown[] = [literal];
  let idx = 2;
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT *, (vector_v::vector <=> $1::vector) AS distance
         FROM intelligence_events ${where}
         ORDER BY vector_v::vector <=> $1::vector LIMIT $${idx++}`,
      [...params, opts.limit ?? 20],
    );
    return rows.map((r) => ({ ...fromRow(r), distance: Number(r.distance) }));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // undefined extension / type / operator => pgvector not installed; degrade gracefully.
    if (code === '42704' || code === '42883' || code === '42P01') return [];
    throw err;
  }
}

export async function getEvent(id: string): Promise<IntelligenceEvent | undefined> {
  const row = await one<Record<string, unknown>>(
    `SELECT * FROM intelligence_events WHERE id = $1`,
    [id],
  );
  return row ? fromRow(row) : undefined;
}

export async function createEvent(event: Omit<IntelligenceEvent, 'createdAt'>): Promise<IntelligenceEvent> {
  const now = Date.now();
  await exec(
    `INSERT INTO intelligence_events
     (id, source_id, kind, title, content, raw_data, media_urls, embedding,
      vector_v, confidence, sensitivity, tags, location_lat, location_lon,
      event_at, created_at, dedupe_hash, score, score_components)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      event.id, event.sourceId, event.kind, event.title ?? null, event.content,
      event.rawData ? JSON.stringify(event.rawData) : null,
      event.mediaUrls ?? null,
      event.embedding ?? null,
      event.vectorV ?? null,
      event.confidence, event.sensitivity,
      JSON.stringify(event.tags),
      event.location?.lat ?? null,
      event.location?.lon ?? null,
      event.eventAt, now, event.dedupeHash ?? null,
      event.score ?? null,
      event.scoreComponents ? JSON.stringify(event.scoreComponents) : null,
    ],
  );
  return { ...event, createdAt: now };
}

export async function dedupeExists(dedupeHash: string): Promise<boolean> {
  const row = await one<{ count: string }>(
    `SELECT COUNT(*) as count FROM intelligence_events WHERE dedupe_hash = $1`,
    [dedupeHash],
  );
  return Number(row?.count ?? 0) > 0;
}

export async function deleteOldEvents(before: number): Promise<number> {
  const result = await query<{ count: string }>(
    `WITH deleted AS (DELETE FROM intelligence_events WHERE created_at < $1 RETURNING *) SELECT COUNT(*) as count FROM deleted`,
    [before],
  );
  return Number(result[0]?.count ?? 0);
}

export function makeDedupeHash(sourceId: string, content: string): string {
  return createHash('sha256').update(`${sourceId}:${content}`).digest('hex').slice(0, 32);
}

// In-process dedupe reservation. dedupeExists() (a DB read) and createEvent() (the
// insert) are separated by a long async pipeline (content filter → LLM enrich →
// MITRE → embed), so within ONE poll the same item can pass the existence check
// 2-3x concurrently and then all insert — the cause of the duplicate events. This
// synchronous reserve-before-enrich guard closes that window for the single feeder
// process (deployment is single-machine by design — multi-machine would double-poll
// anyway). Reservations expire so a genuinely new re-emit after the window is still
// allowed; by then the committed row is caught by dedupeExists() / the DB unique index.
const reservedDedupe = new Map<string, number>();
const DEDUPE_RESERVE_TTL_MS = 5 * 60 * 1000;

export function reserveDedupe(hash: string, now: number = Date.now()): boolean {
  const exp = reservedDedupe.get(hash);
  if (exp !== undefined && exp > now) return false; // already in-flight this window
  if (reservedDedupe.size > 5000) {
    for (const [h, e] of reservedDedupe) if (e <= now) reservedDedupe.delete(h);
  }
  reservedDedupe.set(hash, now + DEDUPE_RESERVE_TTL_MS);
  return true;
}

/** True for a Postgres unique-constraint violation (SQLSTATE 23505) — i.e. a
 * concurrent insert won the race and the dedupe-hash unique index rejected this dup. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function fromRow(row: Record<string, unknown>): IntelligenceEvent {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    kind: row.kind as IntelligenceEvent['kind'],
    title: row.title ? String(row.title) : undefined,
    content: String(row.content),
    rawData: row.raw_data ? (typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data as Record<string, unknown>) : undefined,
    mediaUrls: row.media_urls ? (row.media_urls as string[]) : undefined,
    embedding: row.embedding ? Buffer.from(String(row.embedding)) : undefined,
    vectorV: parseVector(row.vector_v),
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity as IntelligenceEvent['sensitivity'],
    tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags as Record<string, unknown>) : {},
    location:
      row.location_lat != null && row.location_lon != null
        ? { lat: Number(row.location_lat), lon: Number(row.location_lon) }
        : undefined,
    eventAt: Number(row.event_at),
    createdAt: Number(row.created_at),
    dedupeHash: row.dedupe_hash ? String(row.dedupe_hash) : undefined,
    score: row.score != null ? Number(row.score) : undefined,
    scoreComponents: row.score_components
      ? (typeof row.score_components === 'string'
          ? JSON.parse(row.score_components)
          : (row.score_components as IntelligenceEvent['scoreComponents']))
      : undefined,
  };
}

/**
 * Robustly decode a stored embedding back to number[]. node-pg returns `real[]`
 * as a JS array, but a pgvector `vector` column (or some array configs) comes
 * back as the string form "[1,2,3]" / "{1,2,3}" — the old code dropped those,
 * silently disabling text vector search. Handle every shape.
 */
function parseVector(v: unknown): number[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return (v as unknown[]).map(Number).filter((n) => Number.isFinite(n));
  if (typeof v === 'string') {
    const inner = v.trim().replace(/^[[{]/, '').replace(/[\]}]$/, '');
    if (!inner) return undefined;
    const nums = inner.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    return nums.length ? nums : undefined;
  }
  return undefined;
}
