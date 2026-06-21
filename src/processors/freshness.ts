import type { SourceConfig, SourceHealthState, IntelSignal } from '../types.js';
import { listSources } from '../store/sources.js';
import { insertSignal, signalDedupeExists } from '../store/signals.js';
import { bus } from '../bus.js';
import {
  countEventsSince,
  getBaseline,
  updateBaseline,
  setHealthState,
  type VolumeBaseline,
} from '../store/health.js';

/**
 * Freshness / silent-source detection — the "is this feed actually alive?" layer.
 *
 * CLEAN-ROOM. The idea that a source returning HTTP 200 with zero new items for
 * a long stretch is *silently dead* (scraper soft-blocked, feed deprecated, login
 * wall) — and that a sudden drop/burst in per-hour volume is itself a signal —
 * is inspired by worldmonitor (AGPL-3.0). No worldmonitor code, constants, or
 * data tables were copied; the thresholds, state machine, and z-score math below
 * are this project's own.
 *
 * The two classifiers are PURE (no DB / network / clock-of-record) so they are
 * directly unit-testable; the orchestrator `runFreshnessSweep` wires them to the
 * stores and the signal bus.
 */

// A source is treated as SILENT once it has gone this many poll intervals with
// HTTP-OK polls but zero new events. 12 intervals is long enough to ride out a
// genuinely quiet feed (e.g. a low-traffic RSS at a 5-min poll => ~1h of silence
// tolerated) yet short enough to catch a soft-block within an hour or two.
export const SILENCE_INTERVAL_FACTOR = 12;

// Absolute floor so very fast pollers (e.g. 30s) don't trip "silent" after only
// a few minutes of a legitimately idle feed. 6h with no data is suspicious for
// any source regardless of how often we poll it.
export const SILENCE_FLOOR_MS = 6 * 60 * 60 * 1000;

// z-score past which a per-hour volume reading counts as anomalous vs baseline.
export const VOLUME_Z_THRESHOLD = 3;

// Baselines need a few samples before their variance is meaningful; below this we
// refuse to flag anomalies (avoids screaming on the 2nd-ever poll).
export const MIN_BASELINE_SAMPLES = 8;

export interface SilenceInput {
  /** ms epoch of the most recent event this source produced (undefined => never). */
  lastEventAt?: number;
  /** poll cadence in seconds (SourceConfig.pollIntervalSeconds). */
  pollIntervalSeconds: number;
  /** consecutive poll failures; >0 means the source is erroring, not silent. */
  consecutiveFailures?: number;
  /** breaker cooldown end (ms). When in the future the source is in cooldown. */
  cooldownUntil?: number;
}

export interface SilenceResult {
  state: SourceHealthState;
  /** true iff polls succeed (200 OK) but no events have arrived for too long. */
  silent: boolean;
}

/**
 * Classify a source's liveness from timing alone (pure).
 *
 * Precedence: an open circuit breaker (cooldown) and active failures take priority
 * over silence — a failing/cooling source is a *different* problem than a silently
 * dead one. "Silent" is reserved for the insidious case the feeder used to miss:
 * polls return OK, the source just stops producing.
 */
export function classifySilence(src: SilenceInput, now: number): SilenceResult {
  // In an open breaker window => cooldown, regardless of timing.
  if (src.cooldownUntil != null && src.cooldownUntil > now) {
    return { state: 'cooldown', silent: false };
  }

  const failures = src.consecutiveFailures ?? 0;
  if (failures > 0) {
    // Erroring, not silent. A few transient errors => degraded; persistent => failing.
    return { state: failures >= 3 ? 'failing' : 'degraded', silent: false };
  }

  // No event ever recorded: we can't distinguish "brand new" from "born dead",
  // so don't raise silence until at least the floor has elapsed since we'd expect
  // *something*. Without a lastEventAt anchor we stay healthy (let it warm up).
  if (src.lastEventAt == null) {
    return { state: 'healthy', silent: false };
  }

  const intervalMs = Math.max(1, src.pollIntervalSeconds) * 1000;
  const silenceBudget = Math.max(intervalMs * SILENCE_INTERVAL_FACTOR, SILENCE_FLOOR_MS);
  const idleMs = now - src.lastEventAt;

  if (idleMs > silenceBudget) {
    return { state: 'silent', silent: true };
  }
  return { state: 'healthy', silent: false };
}

export interface VolumeAnomalyResult {
  anomaly: boolean;
  direction: 'drop' | 'surge';
  z: number;
}

/**
 * z-score a current per-hour reading against an online baseline (pure).
 *
 * `std` of 0 (a perfectly steady or single-sample source) is treated as "no
 * usable baseline" => never anomalous, to avoid division-by-zero infinities.
 */
export function detectVolumeAnomaly(
  currentPerHour: number,
  baseline: { mean: number; std: number; sampleCount?: number },
): VolumeAnomalyResult {
  const { mean, std } = baseline;
  const samples = baseline.sampleCount ?? Number.POSITIVE_INFINITY;

  if (!Number.isFinite(std) || std <= 0 || samples < MIN_BASELINE_SAMPLES) {
    return { anomaly: false, direction: currentPerHour < mean ? 'drop' : 'surge', z: 0 };
  }

  const z = (currentPerHour - mean) / std;
  const direction: 'drop' | 'surge' = z < 0 ? 'drop' : 'surge';
  return { anomaly: Math.abs(z) >= VOLUME_Z_THRESHOLD, direction, z };
}

/** Welford std from a stored baseline (population stddev). Pure helper. */
export function baselineStd(b: VolumeBaseline): number {
  if (b.sampleCount < 2) return 0;
  const variance = b.m2 / b.sampleCount;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

// ---------------------------------------------------------------------------
// Orchestrator — DB/bus wired; not unit-tested (the pure pieces above are).
// ---------------------------------------------------------------------------

/** Window over which "recent" per-hour volume is measured. */
const VOLUME_WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep all enabled sources: measure recent volume, fold it into each source's
 * online baseline, classify liveness, and emit `silent_source` / `volume_anomaly`
 * signals for newly-degraded sources (deduped one-per-source-per-day). Also keeps
 * `intelligence_sources.health_state` current so /health and the dashboard can
 * stop showing a dead feed as "healthy".
 */
export async function runFreshnessSweep(now: number = Date.now()): Promise<{
  scanned: number;
  silent: number;
  anomalies: number;
}> {
  const sources = await listSources(true);
  let silentCount = 0;
  let anomalyCount = 0;

  for (const source of sources) {
    try {
      await sweepSource(source, now, (kind) => {
        if (kind === 'silent_source') silentCount++;
        else anomalyCount++;
      });
    } catch (err) {
      console.error(
        `[freshness] sweep failed for ${source.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(
    `[freshness] swept ${sources.length} sources (${silentCount} silent, ${anomalyCount} volume anomalies)`,
  );
  return { scanned: sources.length, silent: silentCount, anomalies: anomalyCount };
}

async function sweepSource(
  source: SourceConfig,
  now: number,
  onSignal: (kind: 'silent_source' | 'volume_anomaly') => void,
): Promise<void> {
  // --- recent per-hour volume -> baseline ---
  const recentCount = await countEventsSince(source.id, now - VOLUME_WINDOW_MS);
  const perHour = recentCount; // window is exactly 1h
  const priorBaseline = await getBaseline(source.id);
  const priorStd = priorBaseline ? baselineStd(priorBaseline) : 0;
  const priorMean = priorBaseline?.mean ?? 0;
  const priorSamples = priorBaseline?.sampleCount ?? 0;

  // Fold this reading into the online baseline AFTER snapshotting the prior one,
  // so the current reading is scored against history, not against itself.
  await updateBaseline(source.id, perHour, now);

  // --- liveness classification ---
  const { state, silent } = classifySilence(
    {
      lastEventAt: source.lastEventAt,
      pollIntervalSeconds: source.pollIntervalSeconds,
      consecutiveFailures: source.consecutiveFailures,
      cooldownUntil: source.cooldownUntil,
    },
    now,
  );

  // Persist health_state only when it actually changes (cheap idempotence).
  if (state !== source.healthState) {
    await setHealthState(source.id, state);
  }

  const dayAgo = now - DAY_MS;

  // --- silent-source signal ---
  if (silent) {
    const dedupeKey = `silent_source:${source.id}`;
    if (!(await signalDedupeExists(dedupeKey, dayAgo))) {
      const idleMs = source.lastEventAt != null ? now - source.lastEventAt : undefined;
      const idleHours = idleMs != null ? Math.round(idleMs / (60 * 60 * 1000)) : undefined;
      const sig: Omit<IntelSignal, 'id' | 'createdAt'> = {
        kind: 'silent_source',
        // Confidence-style score: a long silence is a stronger signal. Cap at ~0.9.
        score: Math.min(0.9, 0.5 + (idleHours ?? 0) / 240),
        title: `Source silent: ${source.name}`,
        summary:
          idleHours != null
            ? `Polls succeed but no events for ~${idleHours}h (feed may be dead or soft-blocked).`
            : 'Polls succeed but the source has never produced an event.',
        sourceIds: [source.id],
        dedupeKey,
        metadata: { healthState: state, idleMs, pollIntervalSeconds: source.pollIntervalSeconds },
      };
      const stored = await insertSignal(sig);
      bus.emitSignal(stored);
      onSignal('silent_source');
    }
  }

  // --- volume anomaly signal (only meaningful with a warmed baseline) ---
  const anomaly = detectVolumeAnomaly(perHour, {
    mean: priorMean,
    std: priorStd,
    sampleCount: priorSamples,
  });
  if (anomaly.anomaly) {
    const dedupeKey = `volume_anomaly:${anomaly.direction}:${source.id}`;
    if (!(await signalDedupeExists(dedupeKey, dayAgo))) {
      const sig: Omit<IntelSignal, 'id' | 'createdAt'> = {
        kind: 'volume_anomaly',
        score: Math.min(0.95, 0.4 + Math.abs(anomaly.z) / 10),
        title: `Volume ${anomaly.direction}: ${source.name}`,
        summary: `${perHour}/h vs baseline ${priorMean.toFixed(1)}/h (z=${anomaly.z.toFixed(1)}).`,
        sourceIds: [source.id],
        dedupeKey,
        metadata: {
          direction: anomaly.direction,
          z: anomaly.z,
          perHour,
          baselineMean: priorMean,
          baselineStd: priorStd,
        },
      };
      const stored = await insertSignal(sig);
      bus.emitSignal(stored);
      onSignal('volume_anomaly');
    }
  }
}
