import { query, one, exec, transact } from '../db.js';
import type { EventKind, IntelligenceEvent, RiskBand, DataClass } from '../types.js';
import { deriveDataClass } from '../lib/dataClass.js';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Search query grammar (006). Free-text search supports three modes via a tiny
// prefix/affix grammar so the feed UI can offer contains / wildcard / regex
// without separate params:
//   - bare text         => 'contains'  : current ILIKE %q% behaviour
//   - *term*            => 'wildcard'  : caller's * become SQL ILIKE %, with any
//                                        literal % / _ in the input escaped
//   - /pattern/         => 'regex'     : Postgres case-insensitive `~*`
// Input is capped at MAX_QUERY_LEN to bound both the ILIKE scan and (critically)
// the regex engine's exposure to a runaway/ReDoS-style pattern.
// ---------------------------------------------------------------------------

export const MAX_QUERY_LEN = 200;

export interface ParsedQuery {
  mode: 'contains' | 'wildcard' | 'regex';
  /** The pattern to bind for the chosen mode: an ILIKE pattern (contains/wildcard)
   *  or a raw regex source (regex). */
  pattern: string;
}

/** Escape the SQL LIKE/ILIKE metacharacters % and _ (and the default escape \\)
 *  so user text matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Parse a free-text search string into a search mode + bound pattern. Pure; does
 * no DB work. Over-long input is truncated to MAX_QUERY_LEN before parsing so the
 * affix detection still sees a well-formed `*...*` / `/.../` even after the cap.
 */
export function parseQueryMode(q: string): ParsedQuery {
  const s = (q ?? '').slice(0, MAX_QUERY_LEN).trim();

  // /pattern/ => regex. Require a non-empty body between the slashes.
  if (s.length >= 2 && s.startsWith('/') && s.endsWith('/')) {
    const body = s.slice(1, -1);
    if (body.length) return { mode: 'regex', pattern: body };
  }

  // *term* => wildcard. Translate the caller's * to ILIKE %, escaping any literal
  // LIKE metacharacters in the surrounding text first.
  if (s.length >= 2 && s.startsWith('*') && s.endsWith('*')) {
    const body = s.slice(1, -1);
    if (body.length) {
      const pattern = `%${body.split('*').map(escapeLike).join('%')}%`;
      return { mode: 'wildcard', pattern };
    }
  }

  // bare text => contains (literal substring ILIKE).
  return { mode: 'contains', pattern: `%${escapeLike(s)}%` };
}

/**
 * Run a regex-mode search (Postgres `~*`) under a tight per-statement timeout so a
 * pathological pattern can't pin a backend. Runs inside a transaction with
 * `SET LOCAL statement_timeout` (scoped to this txn only). Degrades to [] on an
 * invalid regex (22023/2201B) or a timeout (57014) instead of surfacing a 500.
 */
async function runRegexSearch(
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  try {
    return await transact(async (client) => {
      await client.query(`SET LOCAL statement_timeout = '3000ms'`);
      const result = await client.query<Record<string, unknown>>(sql, params);
      return result.rows;
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // 57014 statement_timeout; 2201B invalid_regular_expression; 22023 invalid_parameter_value.
    if (code === '57014' || code === '2201B' || code === '22023') return [];
    throw err;
  }
}

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
  dataClass?: DataClass;
  riskBand?: RiskBand;
  minScore?: number;
  limit?: number;
}): Promise<IntelligenceEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  let isRegex = false;
  if (opts.query) {
    const parsed = parseQueryMode(opts.query);
    const op = parsed.mode === 'regex' ? '~*' : 'ILIKE';
    isRegex = parsed.mode === 'regex';
    conditions.push(`(content ${op} $${idx} OR title ${op} $${idx})`);
    params.push(parsed.pattern);
    idx++;
  }
  if (opts.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }
  if (opts.dataClass) { conditions.push(`data_class = $${idx++}`); params.push(opts.dataClass); }
  if (opts.riskBand) { conditions.push(`risk_band = $${idx++}`); params.push(opts.riskBand); }
  if (typeof opts.minScore === 'number') { conditions.push(`COALESCE(score, confidence) >= $${idx++}`); params.push(opts.minScore); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = typeof opts.limit === 'number' ? Math.min(Math.max(1, opts.limit), 500) : 150;

  // DISTINCT ON the title key keeps the newest row per title; survivors are then
  // ordered by recency and capped. The dedupe key falls back to the id for rows
  // with no usable title so genuinely distinct untitled events are preserved.
  const sql = `SELECT * FROM (
       SELECT DISTINCT ON (COALESCE(NULLIF(lower(btrim(title)), ''), id::text)) *
         FROM intelligence_events ${where}
        ORDER BY COALESCE(NULLIF(lower(btrim(title)), ''), id::text), event_at DESC
     ) d
     ORDER BY event_at DESC
     LIMIT $${idx++}`;
  const args = [...params, limit];
  const rows = isRegex ? await runRegexSearch(sql, args) : await query<Record<string, unknown>>(sql, args);
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

  let isRegex = false;
  if (opts.query) {
    const parsed = parseQueryMode(opts.query);
    const op = parsed.mode === 'regex' ? '~*' : 'ILIKE';
    isRegex = parsed.mode === 'regex';
    conditions.push(`(content ${op} $${idx} OR title ${op} $${idx})`);
    params.push(parsed.pattern);
    idx++;
  }
  if (opts.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT * FROM intelligence_events ${where} ORDER BY event_at DESC LIMIT $${idx++}`;
  const args = [...params, opts.limit ?? 20];
  const rows = isRegex ? await runRegexSearch(sql, args) : await query<Record<string, unknown>>(sql, args);
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
  /** Restrict to events whose SOURCE kind is in this set (joins
   *  intelligence_sources). Used by the news feed to include only news sources
   *  (hn/rss/social/…) and exclude alert/intel sources (nws/usgs/nvd/…), which
   *  otherwise dominate by volume + confidence and make Discover look like the
   *  Events feed. */
  sourceKinds?: string[];
  minScore?: number;
  dataClass?: DataClass;
  riskBand?: RiskBand;
  limit?: number;
}): Promise<IntelligenceEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Columns qualified `e.` because the optional sources join also has a `kind`.
  if (opts.since) { conditions.push(`e.event_at >= $${idx++}`); params.push(opts.since); }
  if (opts.kinds?.length) { conditions.push(`e.kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.sourceId) { conditions.push(`e.source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts.sourceKinds?.length) { conditions.push(`s.kind = ANY($${idx++}::text[])`); params.push(opts.sourceKinds); }
  if (typeof opts.minScore === 'number') { conditions.push(`COALESCE(e.score, e.confidence) >= $${idx++}`); params.push(opts.minScore); }
  if (opts.dataClass) { conditions.push(`e.data_class = $${idx++}`); params.push(opts.dataClass); }
  if (opts.riskBand) { conditions.push(`e.risk_band = $${idx++}`); params.push(opts.riskBand); }

  const join = opts.sourceKinds?.length ? `JOIN intelligence_sources s ON s.id = e.source_id` : '';
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT e.* FROM intelligence_events e ${join} ${where}
     ORDER BY COALESCE(e.score, e.confidence) DESC, e.event_at DESC LIMIT $${idx++}`,
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
      event_at, created_at, dedupe_hash, score, score_components, risk_band, data_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
      event.riskBand ?? null,
      event.dataClass ?? null,
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

// ---------------------------------------------------------------------------
// 006: event lineage (provenance) + data-class backfill.
//
// The ~16 recon processors already stamp `tags.parent_event_id` (and
// `tags.recon_type`) on every derived event but nothing reads it. This promotes
// that trapped provenance into the indexed `event_lineage` edge table and fills
// in `data_class` — both via ONE idempotent bulk sweep over recent rows, so no
// per-processor edits are needed. Also exposes a single-event lineage read.
// ---------------------------------------------------------------------------

/** Insert one event→event provenance edge (idempotent). */
export async function recordLineage(
  childEventId: string,
  parentEventId: string,
  relation = 'derived',
  processor?: string,
): Promise<void> {
  if (!childEventId || !parentEventId || childEventId === parentEventId) return;
  await exec(
    `INSERT INTO event_lineage (child_event_id, parent_event_id, relation, processor, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (child_event_id, parent_event_id, relation) DO NOTHING`,
    [childEventId, parentEventId, relation, processor ?? null, Date.now()],
  );
}

export interface LineageSweepResult { scanned: number; edges: number; classified: number }

/**
 * Backfill event_lineage edges from `tags.parent_event_id` and `data_class` from
 * kind+tags, over events since `sinceMs`. Idempotent (ON CONFLICT / only fills
 * NULL data_class), bounded by `limit`, and off the hot path (cron). Returns counts.
 */
export async function runLineageSweep(sinceMs: number, limit = 4000): Promise<LineageSweepResult> {
  const rows = await query<{ id: string; kind: string; tags: unknown; data_class: string | null }>(
    `SELECT id, kind, tags, data_class FROM intelligence_events
      WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`,
    [sinceMs, limit],
  );

  let edges = 0;
  let classified = 0;
  for (const r of rows) {
    const tags =
      r.tags == null ? {} : typeof r.tags === 'string' ? safeParse(r.tags) : (r.tags as Record<string, unknown>);

    const parent = tags.parent_event_id;
    if (typeof parent === 'string' && parent && parent !== r.id) {
      const processor = typeof tags.recon_type === 'string' ? tags.recon_type : undefined;
      await recordLineage(r.id, parent, 'derived', processor);
      edges += 1;
    }

    if (!r.data_class) {
      const dc = deriveDataClass({ kind: r.kind as EventKind, tags });
      if (dc) {
        await exec(`UPDATE intelligence_events SET data_class = $1 WHERE id = $2 AND data_class IS NULL`, [dc, r.id]);
        classified += 1;
      }
    }
  }
  return { scanned: rows.length, edges, classified };
}

export interface LineageNeighbor {
  eventId: string;
  relation: string;
  processor?: string;
  title?: string;
  kind?: string;
  eventAt?: number;
}

/**
 * Parents and children of an event, hydrated with title/kind/time where the
 * neighbor still exists (retention may have purged it — those degrade to id-only,
 * not an error).
 */
export async function getEventLineage(
  eventId: string,
): Promise<{ parents: LineageNeighbor[]; children: LineageNeighbor[] }> {
  const parents = await query<Record<string, unknown>>(
    `SELECT l.parent_event_id AS event_id, l.relation, l.processor,
            e.title, e.kind, e.event_at
       FROM event_lineage l
       LEFT JOIN intelligence_events e ON e.id = l.parent_event_id
      WHERE l.child_event_id = $1
      ORDER BY e.event_at DESC NULLS LAST`,
    [eventId],
  );
  const children = await query<Record<string, unknown>>(
    `SELECT l.child_event_id AS event_id, l.relation, l.processor,
            e.title, e.kind, e.event_at
       FROM event_lineage l
       LEFT JOIN intelligence_events e ON e.id = l.child_event_id
      WHERE l.parent_event_id = $1
      ORDER BY e.event_at DESC NULLS LAST`,
    [eventId],
  );
  const map = (rows: Record<string, unknown>[]): LineageNeighbor[] =>
    rows.map((r) => ({
      eventId: String(r.event_id),
      relation: String(r.relation),
      processor: r.processor ? String(r.processor) : undefined,
      title: r.title ? String(r.title) : undefined,
      kind: r.kind ? String(r.kind) : undefined,
      eventAt: r.event_at != null ? Number(r.event_at) : undefined,
    }));
  return { parents: map(parents), children: map(children) };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
    riskBand: row.risk_band ? (String(row.risk_band) as RiskBand) : undefined,
    dataClass: row.data_class ? (String(row.data_class) as DataClass) : undefined,
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

// ---------------------------------------------------------------------------
// 006: read-path exports (CSV / NDJSON). A stable, flat column projection of an
// IntelligenceEvent so the list route can stream events out via lib/exporters.
// Nested location is split into lat/lon; country + cluster_id are lifted out of
// `tags` (where adapters/correlation stamp them) so they're first-class columns.
// ---------------------------------------------------------------------------

/** Fixed column order for event CSV/NDJSON exports. */
export const EVENT_EXPORT_COLUMNS: string[] = [
  'id',
  'source_id',
  'kind',
  'title',
  'content',
  'score',
  'risk_band',
  'data_class',
  'confidence',
  'event_at',
  'lat',
  'lon',
  'country',
  'cluster_id',
];

/** Flatten an IntelligenceEvent to the stable EVENT_EXPORT_COLUMNS key set. */
export function eventToExportRow(e: IntelligenceEvent): Record<string, unknown> {
  const tags = (e.tags ?? {}) as Record<string, unknown>;
  const country = typeof tags.country === 'string' ? tags.country : undefined;
  const clusterId =
    typeof tags.cluster_id === 'string'
      ? tags.cluster_id
      : typeof tags.clusterId === 'string'
        ? (tags.clusterId as string)
        : undefined;
  return {
    id: e.id,
    source_id: e.sourceId,
    kind: e.kind,
    title: e.title ?? '',
    content: e.content,
    score: e.score ?? '',
    risk_band: e.riskBand ?? '',
    data_class: e.dataClass ?? '',
    confidence: e.confidence,
    event_at: new Date(e.eventAt).toISOString(),
    lat: e.location?.lat ?? '',
    lon: e.location?.lon ?? '',
    country: country ?? '',
    cluster_id: clusterId ?? '',
  };
}
