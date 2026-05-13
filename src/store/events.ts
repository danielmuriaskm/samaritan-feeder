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

export async function searchEvents(opts: {
  query?: string;
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
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`event_at >= $${idx++}`); params.push(opts.since); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_events ${where} ORDER BY event_at DESC LIMIT $${idx++}`,
    [...params, opts.limit ?? 20],
  );
  return rows.map(fromRow);
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
      event_at, created_at, dedupe_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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

function fromRow(row: Record<string, unknown>): IntelligenceEvent {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    kind: row.kind as IntelligenceEvent['kind'],
    title: row.title ? String(row.title) : undefined,
    content: String(row.content),
    rawData: row.raw_data ? JSON.parse(String(row.raw_data)) : undefined,
    mediaUrls: row.media_urls ? (row.media_urls as string[]) : undefined,
    embedding: row.embedding ? Buffer.from(String(row.embedding)) : undefined,
    vectorV: row.vector_v ? (Array.isArray(row.vector_v) ? row.vector_v as number[] : undefined) : undefined,
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity as IntelligenceEvent['sensitivity'],
    tags: row.tags ? JSON.parse(String(row.tags)) : {},
    location:
      row.location_lat != null && row.location_lon != null
        ? { lat: Number(row.location_lat), lon: Number(row.location_lon) }
        : undefined,
    eventAt: Number(row.event_at),
    createdAt: Number(row.created_at),
    dedupeHash: row.dedupe_hash ? String(row.dedupe_hash) : undefined,
  };
}
