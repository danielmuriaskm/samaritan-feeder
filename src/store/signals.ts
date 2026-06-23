import { query, exec } from '../db.js';
import type { IntelSignal, SignalKind, TriageState } from '../types.js';
import { deriveRiskBand } from '../scoring/severity.js';
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
  const riskBand = deriveRiskBand(sig.score);
  await exec(
    `INSERT INTO intelligence_signals
       (id, kind, score, title, summary, cluster_id, source_ids, event_ids,
        location_lat, location_lon, window_start, window_end, dedupe_key, metadata, risk_band, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, sig.kind, sig.score, sig.title, sig.summary ?? null, sig.clusterId ?? null,
      sig.sourceIds ?? null, sig.eventIds ?? null,
      sig.location?.lat ?? null, sig.location?.lon ?? null,
      sig.windowStart ?? null, sig.windowEnd ?? null, sig.dedupeKey ?? null,
      JSON.stringify(sig.metadata ?? {}), riskBand, createdAt,
    ],
  );
  return { ...sig, id, createdAt, riskBand };
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
  triageStates?: TriageState[];
  excludeDismissed?: boolean;
} = {}): Promise<IntelSignal[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.kinds?.length) { conditions.push(`kind = ANY($${idx++}::text[])`); params.push(opts.kinds); }
  if (opts.since) { conditions.push(`created_at >= $${idx++}`); params.push(opts.since); }
  if (typeof opts.minScore === 'number') { conditions.push(`score >= $${idx++}`); params.push(opts.minScore); }
  if (opts.triageStates?.length) {
    conditions.push(`triage_state = ANY($${idx++}::text[])`);
    params.push(opts.triageStates);
  } else if (opts.excludeDismissed) {
    conditions.push(`triage_state <> 'dismissed'`);
  }
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
    triageState: row.triage_state ? (row.triage_state as TriageState) : undefined,
    mutedUntil: row.muted_until != null ? Number(row.muted_until) : undefined,
    riskBand: row.risk_band ? (row.risk_band as IntelSignal['riskBand']) : undefined,
  };
}

/** Fetch a single signal by id, or undefined if it does not exist. */
export async function getSignal(id: string): Promise<IntelSignal | undefined> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_signals WHERE id = $1`,
    [id],
  );
  return rows[0] ? fromRow(rows[0]) : undefined;
}

/** Move a signal through its operator triage lifecycle (open/acknowledged/dismissed). */
export async function setSignalTriage(id: string, state: TriageState): Promise<void> {
  await exec(
    `UPDATE intelligence_signals SET triage_state = $1 WHERE id = $2`,
    [state, id],
  );
}

// ---------------------------------------------------------------------------
// 006 mute list (SpiderFoot-inspired false-positive suppression). Mutes are
// keyed by `dedupe_key`, so muting one signal suppresses the whole recurring
// family. Backed by the `signal_mutes` table (dedupe_key PK). The convergence
// and freshness detectors check `isMuted` before inserting a new signal.
// ---------------------------------------------------------------------------

/**
 * Mute a dedupe key. `mutedUntil` is an epoch-ms expiry, or `null` for a
 * permanent mute. UPSERTs so re-muting refreshes the expiry/reason.
 */
export async function muteDedupeKey(
  dedupeKey: string,
  mutedUntil: number | null,
  reason?: string,
): Promise<void> {
  await exec(
    `INSERT INTO signal_mutes (dedupe_key, muted_until, reason, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET muted_until = EXCLUDED.muted_until,
           reason = EXCLUDED.reason`,
    [dedupeKey, mutedUntil, reason ?? null, Date.now()],
  );
}

/**
 * True if `dedupeKey` is currently muted — either a permanent mute
 * (muted_until IS NULL) or one whose expiry is still in the future.
 */
export async function isMuted(dedupeKey: string, now: number = Date.now()): Promise<boolean> {
  const rows = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM signal_mutes
     WHERE dedupe_key = $1 AND (muted_until IS NULL OR muted_until > $2)`,
    [dedupeKey, now],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Remove a mute entry entirely (un-suppress the dedupe family). */
export async function unmuteDedupeKey(dedupeKey: string): Promise<void> {
  await exec(`DELETE FROM signal_mutes WHERE dedupe_key = $1`, [dedupeKey]);
}

/** List all current mute entries (active and expired) for an operator review UI. */
export async function listMutes(): Promise<
  Array<{ dedupeKey: string; mutedUntil?: number; reason?: string }>
> {
  const rows = await query<Record<string, unknown>>(
    `SELECT dedupe_key, muted_until, reason FROM signal_mutes ORDER BY created_at DESC`,
  );
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    mutedUntil: row.muted_until != null ? Number(row.muted_until) : undefined,
    reason: row.reason ? String(row.reason) : undefined,
  }));
}

/**
 * Convenience: mute the dedupe family that a given signal belongs to. Looks up
 * the signal's `dedupe_key` and mutes it. No-op if the signal is missing or has
 * no dedupe key.
 */
export async function muteSignal(
  id: string,
  mutedUntil: number | null,
  reason?: string,
): Promise<void> {
  const sig = await getSignal(id);
  if (!sig?.dedupeKey) return;
  await muteDedupeKey(sig.dedupeKey, mutedUntil, reason);
}
