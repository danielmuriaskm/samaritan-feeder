import { query, exec, transact } from '../db.js';
import { config } from '../config.js';
import type { AlertFiring, CvAnalytics, IntelligenceEvent } from '../types.js';
import { randomUUID } from 'crypto';

/**
 * Persist the per-track / per-zone detail of a CV detection event into the
 * cv_* tables. The summary lives on the intelligence_events row (tags.cv); this
 * is the queryable granular layer.
 *
 * Cross-clip reconciliation: a confirmed track whose dedupe_key matches a recent
 * row (same source + zone-set + class + coarse bbox bucket) UPDATES that row's
 * last_seen/frames instead of inserting a new one — so a parked car does not
 * spawn a fresh record every poll. No identity/embedding is used; dedupe_key is
 * a coarse spatial hash only.
 */
export async function persistCvDetail(event: IntelligenceEvent): Promise<void> {
  const cv = event.tags?.cv as CvAnalytics | undefined;
  if (!cv) return;
  const hasDetail = (cv.tracks?.length ?? 0) > 0 || (cv.zones?.length ?? 0) > 0 || (cv.lines?.length ?? 0) > 0;
  if (!hasDetail) return;

  const now = Date.now();
  const windowEnd = event.eventAt;
  const windowStart = event.eventAt - Math.round((cv.clip?.durationSec ?? 0) * 1000);
  const dedupeWindowStart = now - config.CV_TRACK_DEDUPE_WINDOW_MS;

  await transact(async (client) => {
    for (const t of cv.tracks ?? []) {
      // Compose the cross-clip dedupe key from ALLOWLISTED fields only (the
      // sidecar supplies just a strict "BXxBY" bucket — no free-text channel).
      const dedupeKey = t.bboxBucket
        ? `${event.sourceId}:${[...t.zonesEntered].sort().join(',')}:${t.label}:${t.bboxBucket}`
        : undefined;

      let reconciled = false;
      if (dedupeKey) {
        // Scope to PRIOR clips only (created_at < this clip's logical time) so two
        // co-occurring same-bucket objects in THIS clip don't merge into one.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM cv_track_events
             WHERE source_id = $1 AND dedupe_key = $2 AND created_at >= $3 AND created_at < $4
             ORDER BY created_at DESC LIMIT 1`,
          [event.sourceId, dedupeKey, dedupeWindowStart, event.eventAt],
        );
        if (existing.rows[0]) {
          await client.query(
            `UPDATE cv_track_events
               SET last_seen_ms = GREATEST(last_seen_ms, $1),
                   frames_seen = frames_seen + $2,
                   top_score = GREATEST(top_score, $3),
                   max_dwell_sec = GREATEST(COALESCE(max_dwell_sec, 0), $4),
                   edge_touched = edge_touched OR $5,
                   zones_entered = (SELECT array(SELECT DISTINCT unnest(zones_entered || $6::text[])))
             WHERE id = $7`,
            [t.lastSeenMs, t.framesSeen, t.topScore, t.maxDwellSec ?? 0, t.edgeTouched, t.zonesEntered, existing.rows[0].id],
          );
          reconciled = true;
        }
      }
      if (!reconciled) {
        await client.query(
          `INSERT INTO cv_track_events
             (id, event_id, source_id, label, top_score, frames_seen, first_seen_ms,
              last_seen_ms, max_dwell_sec, zones_entered, edge_touched, dedupe_key, best_frame, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13)`,
          [
            randomUUID(), event.id, event.sourceId, t.label, t.topScore, t.framesSeen,
            t.firstSeenMs, t.lastSeenMs, t.maxDwellSec ?? null, t.zonesEntered,
            t.edgeTouched, dedupeKey ?? null, now,
          ],
        );
      }
    }

    for (const z of cv.zones ?? []) {
      await client.query(
        `INSERT INTO cv_zone_counts
           (id, event_id, source_id, zone_id, line_id, name, peak_occupancy, in_count, out_count,
            class_counts, window_start_ms, window_end_ms, created_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,NULL,NULL,$7,$8,$9,$10)`,
        [
          randomUUID(), event.id, event.sourceId, z.id, z.name ?? null,
          z.peakOccupancy ?? z.occupancy, JSON.stringify(z.classCounts ?? {}),
          windowStart, windowEnd, now,
        ],
      );
    }

    for (const l of cv.lines ?? []) {
      await client.query(
        `INSERT INTO cv_zone_counts
           (id, event_id, source_id, zone_id, line_id, name, peak_occupancy, in_count, out_count,
            class_counts, window_start_ms, window_end_ms, created_at)
         VALUES ($1,$2,$3,NULL,$4,$5,NULL,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(), event.id, event.sourceId, l.id, l.name ?? null,
          l.in, l.out, JSON.stringify(l.perClass ?? {}), windowStart, windowEnd, now,
        ],
      );
    }
  });
}

/**
 * Persist CV alert-rule firings for a kind:'alert' event. Writes one cv_alerts
 * row per firing; the REDACTED best-frame (if any) is stored on the first row
 * and is NEVER written into intelligence_events.
 */
export async function persistCvAlerts(event: IntelligenceEvent, artifactBase64?: string): Promise<void> {
  const firings = event.tags?.alertFirings as AlertFiring[] | undefined;
  if (!firings?.length) return;

  const now = Date.now();
  const artifact = artifactBase64 ? Buffer.from(artifactBase64, 'base64') : null;
  // Attach the redacted frame only to the first push-worthy ('alert') firing —
  // record-only firings never carry stored imagery.
  const artifactIdx = firings.findIndex((f) => f.severity === 'alert');

  await transact(async (client) => {
    for (let i = 0; i < firings.length; i++) {
      const f = firings[i];
      await client.query(
        `INSERT INTO cv_alerts
           (id, event_id, source_id, rule_id, alert_type, zone_id, line_id, value, threshold, severity, best_frame, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(), event.id, event.sourceId, f.ruleId, f.type, f.zoneId ?? null, f.lineId ?? null,
          f.value, f.threshold, f.severity, i === artifactIdx ? artifact : null, now,
        ],
      );
    }
  });
}

/** Purge REDACTED best-frame bytes from cv_track_events + cv_alerts at the raw window. */
export async function purgeCvRawOlderThan(before: number): Promise<number> {
  const a = await query<{ count: string }>(
    `WITH updated AS (
       UPDATE cv_track_events SET best_frame = NULL
       WHERE best_frame IS NOT NULL AND created_at < $1 RETURNING id
     ) SELECT COUNT(*) as count FROM updated`,
    [before],
  );
  const b = await query<{ count: string }>(
    `WITH updated AS (
       UPDATE cv_alerts SET best_frame = NULL
       WHERE best_frame IS NOT NULL AND created_at < $1 RETURNING id
     ) SELECT COUNT(*) as count FROM updated`,
    [before],
  );
  return Number(a[0]?.count ?? 0) + Number(b[0]?.count ?? 0);
}

/**
 * Store a CLIP embedding of a REDACTED alert frame for semantic search. Runs in
 * its OWN connection (not the cv_alerts transaction) so a missing cv_embeddings
 * table / pgvector extension can never break core alert persistence. No-op
 * unless CV_SEMANTIC_SEARCH is on and the vector is valid.
 */
export async function insertCvEmbedding(event: IntelligenceEvent, embedding: number[] | undefined): Promise<void> {
  if (!config.CV_SEMANTIC_SEARCH || !embedding || embedding.length !== config.CV_CLIP_DIM) return;
  const literal = `[${embedding.join(',')}]`;
  // caption is the PII-free alert summary (event.content) for display in results.
  await exec(
    `INSERT INTO cv_embeddings (id, event_id, source_id, embedding, caption, created_at)
     VALUES ($1,$2,$3,$4::vector,$5,$6)`,
    [randomUUID(), event.id, event.sourceId, literal, event.content.slice(0, 500), Date.now()],
  );
}

/** Raised when the optional pgvector schema is missing or mismatched. */
export class SemanticSearchUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticSearchUnavailable';
  }
}

/** Semantic search: nearest alert frames to a query embedding (cosine). */
export async function searchAlertsByText(queryEmbedding: number[], limit = 20): Promise<Record<string, unknown>[]> {
  if (queryEmbedding.length !== config.CV_CLIP_DIM) return [];
  const literal = `[${queryEmbedding.join(',')}]`;
  try {
    return await query(
      `SELECT em.event_id, em.source_id, em.caption, em.created_at,
              (em.embedding <=> $1::vector) AS distance
         FROM cv_embeddings em
         ORDER BY em.embedding <=> $1::vector
         LIMIT $2`,
      [literal, limit],
    );
  } catch (err) {
    // 42P01 undefined_table, 42704 undefined_object (extension), 42883 undefined_function (operator)
    const code = (err as { code?: string })?.code;
    if (code === '42P01' || code === '42704' || code === '42883') {
      throw new SemanticSearchUnavailable(
        'Semantic search schema missing — run `npm run db:migrate:semantic` on a pgvector Postgres',
      );
    }
    throw err;
  }
}

/** Recent alert firings for a source (dashboard / proactive review). */
export async function recentAlerts(sourceId: string, since: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT id, event_id, rule_id, alert_type, zone_id, line_id, value, threshold, severity, created_at
       FROM cv_alerts WHERE source_id = $1 AND created_at >= $2 ORDER BY created_at DESC`,
    [sourceId, since],
  );
}

/** Recent CV aggregates for a source (dashboard / trend queries). */
export async function recentZoneCounts(sourceId: string, since: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT zone_id, line_id, name, peak_occupancy, in_count, out_count, class_counts, created_at
       FROM cv_zone_counts WHERE source_id = $1 AND created_at >= $2 ORDER BY created_at DESC`,
    [sourceId, since],
  );
}
