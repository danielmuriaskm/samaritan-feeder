import { query, exec } from '../db.js';
import type { IntelSignal, SignalKind } from '../types.js';
import { randomUUID } from 'crypto';

/**
 * Store for correlation / freshness signals (005). Shared primitive: the
 * convergence and freshness processors both write here, and routes/MCP read.
 */

export async function insertSignal(
  sig: Omit<IntelSignal, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<IntelSignal> {
  const id = sig.id ?? randomUUID();
  const createdAt = sig.createdAt ?? Date.now();
  await exec(
    `INSERT INTO intelligence_signals
       (id, kind, score, title, summary, cluster_id, source_ids, event_ids,
        location_lat, location_lon, window_start, window_end, dedupe_key, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id, sig.kind, sig.score, sig.title, sig.summary ?? null, sig.clusterId ?? null,
      sig.sourceIds ?? null, sig.eventIds ?? null,
      sig.location?.lat ?? null, sig.location?.lon ?? null,
      sig.windowStart ?? null, sig.windowEnd ?? null, sig.dedupeKey ?? null,
      JSON.stringify(sig.metadata ?? {}), createdAt,
    ],
  );
  return { ...sig, id, createdAt };
}

/** True if a signal with this dedupe key fired since `since` (anti-spam). */
export async function signalDedupeExists(dedupeKey: string, since: number): Promise<boolean> {
  const rows = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM intelligence_signals WHERE dedupe_key = $1 AND created_at >= $2`,
    [dedupeKey, since],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function listSignals(opts: {
  kinds?: SignalKind[];
  since?: number;
  minScore?: number;
  limit?: number;
} = {}): Promise<IntelSignal[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`created_at >= $${idx++}`); params.push(opts.since); }
  if (typeof opts.minScore === 'number') { conditions.push(`score >= $${idx++}`); params.push(opts.minScore); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_signals ${where} ORDER BY score DESC, created_at DESC LIMIT $${idx++}`,
    [...params, opts.limit ?? 50],
  );
  return rows.map(fromRow);
}

function fromRow(row: Record<string, unknown>): IntelSignal {
  return {
    id: String(row.id),
    kind: row.kind as SignalKind,
    score: Number(row.score),
    title: String(row.title),
    summary: row.summary ? String(row.summary) : undefined,
    clusterId: row.cluster_id ? String(row.cluster_id) : undefined,
    sourceIds: Array.isArray(row.source_ids) ? (row.source_ids as string[]) : undefined,
    eventIds: Array.isArray(row.event_ids) ? (row.event_ids as string[]) : undefined,
    location:
      row.location_lat != null && row.location_lon != null
        ? { lat: Number(row.location_lat), lon: Number(row.location_lon) }
        : undefined,
    windowStart: row.window_start != null ? Number(row.window_start) : undefined,
    windowEnd: row.window_end != null ? Number(row.window_end) : undefined,
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : undefined,
    metadata: row.metadata
      ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>))
      : undefined,
    createdAt: Number(row.created_at),
  };
}
