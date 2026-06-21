import { query, one, exec } from '../db.js';
import type { SourceHealthState } from '../types.js';

/**
 * Source-health store (005). Two concerns:
 *   1. Welford online mean/variance of a source's per-hour event volume
 *      (`source_volume_baseline`) — lets the freshness sweep flag a volume
 *      drop/surge without retaining a full time series.
 *   2. Recent event counts per source + the `health_state` column on
 *      `intelligence_sources`, so a silently-dead feed stops reading "healthy".
 *
 * The freshness processor (src/processors/freshness.ts) is the sole writer.
 */

export interface VolumeBaseline {
  sourceId: string;
  /** Running mean of per-hour event volume. */
  mean: number;
  /** Welford M2 (sum of squared deltas) — variance = m2 / sampleCount. */
  m2: number;
  sampleCount: number;
  updatedAt: number;
}

/** Read a source's volume baseline, or undefined if it has never been sampled. */
export async function getBaseline(sourceId: string): Promise<VolumeBaseline | undefined> {
  const row = await one<Record<string, unknown>>(
    `SELECT source_id, mean_per_hour, m2, sample_count, updated_at
       FROM source_volume_baseline WHERE source_id = $1`,
    [sourceId],
  );
  if (!row) return undefined;
  return {
    sourceId: String(row.source_id),
    mean: Number(row.mean_per_hour),
    m2: Number(row.m2),
    sampleCount: Number(row.sample_count),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Fold one per-hour sample into the source's online baseline (Welford's
 * algorithm). Upserts the row; first sample seeds mean=sample, m2=0.
 *
 * Welford update for the new count n, mean µ, M2:
 *   delta  = x - µ
 *   µ'     = µ + delta / n
 *   M2'    = M2 + delta * (x - µ')
 */
export async function updateBaseline(
  sourceId: string,
  perHourSample: number,
  now: number = Date.now(),
): Promise<VolumeBaseline> {
  const prior = await getBaseline(sourceId);

  let count: number;
  let mean: number;
  let m2: number;

  if (!prior || prior.sampleCount === 0) {
    count = 1;
    mean = perHourSample;
    m2 = 0;
  } else {
    count = prior.sampleCount + 1;
    const delta = perHourSample - prior.mean;
    mean = prior.mean + delta / count;
    m2 = prior.m2 + delta * (perHourSample - mean);
  }

  await exec(
    `INSERT INTO source_volume_baseline (source_id, mean_per_hour, m2, sample_count, updated_at)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_id) DO UPDATE SET
       mean_per_hour = EXCLUDED.mean_per_hour,
       m2            = EXCLUDED.m2,
       sample_count  = EXCLUDED.sample_count,
       updated_at    = EXCLUDED.updated_at`,
    [sourceId, mean, m2, count, now],
  );

  return { sourceId, mean, m2, sampleCount: count, updatedAt: now };
}

/** Count events a source has produced since `since` (ms epoch). */
export async function countEventsSince(sourceId: string, since: number): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT COUNT(*) AS count FROM intelligence_events
       WHERE source_id = $1 AND created_at >= $2`,
    [sourceId, since],
  );
  return Number(row?.count ?? 0);
}

/** Persist the classified health state on the source row. */
export async function setHealthState(sourceId: string, state: SourceHealthState): Promise<void> {
  await exec(
    `UPDATE intelligence_sources SET health_state = $1, updated_at = $2 WHERE id = $3`,
    [state, Date.now(), sourceId],
  );
}

/**
 * Snapshot of every source's current health_state — convenience read for a
 * /health or /dashboard endpoint so a dead feed is no longer rendered "healthy".
 */
export async function listSourceHealth(): Promise<
  Array<{ id: string; name: string; kind: string; healthState: SourceHealthState | null; lastEventAt: number | null }>
> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, name, kind, health_state, last_event_at
       FROM intelligence_sources ORDER BY name`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind),
    healthState: r.health_state ? (r.health_state as SourceHealthState) : null,
    lastEventAt: r.last_event_at != null ? Number(r.last_event_at) : null,
  }));
}
