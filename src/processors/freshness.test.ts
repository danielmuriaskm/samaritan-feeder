import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time, and freshness.ts transitively imports
// the stores -> db.ts -> config.ts. Provide the minimum so importing the module
// under test doesn't require a real database (the pure fns never touch the pool).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/test';
process.env.SAMARITAN_AUTH_TOKEN ??= 'test-token';

const {
  classifySilence,
  detectVolumeAnomaly,
  baselineStd,
  SILENCE_INTERVAL_FACTOR,
  SILENCE_FLOOR_MS,
  VOLUME_Z_THRESHOLD,
  MIN_BASELINE_SAMPLES,
} = await import('./freshness.js');
type SilenceInput = Parameters<typeof classifySilence>[0];

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function src(partial: Partial<SilenceInput>): SilenceInput {
  return { pollIntervalSeconds: 300, consecutiveFailures: 0, ...partial };
}

// --- classifySilence -------------------------------------------------------

test('healthy: recent event within the silence budget', () => {
  // 5-min poll => interval budget = 12 * 5min = 60min, but floor is 6h => 6h budget.
  const r = classifySilence(src({ lastEventAt: NOW - 30 * MIN }), NOW);
  assert.equal(r.silent, false);
  assert.equal(r.state, 'healthy');
});

test('silent: 200-OK polls but no events for longer than the budget', () => {
  // No failures, last event 7h ago, beyond the 6h floor.
  const r = classifySilence(src({ lastEventAt: NOW - 7 * HOUR }), NOW);
  assert.equal(r.silent, true);
  assert.equal(r.state, 'silent');
});

test('silence budget uses the floor for fast pollers', () => {
  // 30s poll: interval budget = 12 * 30s = 6min, but floor (6h) dominates so a
  // feed idle 1h is NOT silent — a fast poller on a quiet feed stays healthy.
  const budget = Math.max(30 * 1000 * SILENCE_INTERVAL_FACTOR, SILENCE_FLOOR_MS);
  assert.equal(budget, SILENCE_FLOOR_MS);
  const r = classifySilence(src({ pollIntervalSeconds: 30, lastEventAt: NOW - 1 * HOUR }), NOW);
  assert.equal(r.silent, false);
  assert.equal(r.state, 'healthy');
});

test('silence budget scales with interval for slow pollers', () => {
  // 2h poll => interval budget = 12 * 2h = 24h, dominates the 6h floor. A feed
  // idle 10h with a 2h cadence is still healthy (only ~5 intervals missed).
  const r = classifySilence(src({ pollIntervalSeconds: 2 * 3600, lastEventAt: NOW - 10 * HOUR }), NOW);
  assert.equal(r.silent, false);
  // ...but 30h idle (>24h budget) trips silent.
  const r2 = classifySilence(src({ pollIntervalSeconds: 2 * 3600, lastEventAt: NOW - 30 * HOUR }), NOW);
  assert.equal(r2.silent, true);
  assert.equal(r2.state, 'silent');
});

test('failing/degraded: active failures are not "silent"', () => {
  // Even with a long idle gap, an erroring source is failing, not silent.
  const degraded = classifySilence(src({ lastEventAt: NOW - 10 * HOUR, consecutiveFailures: 1 }), NOW);
  assert.equal(degraded.silent, false);
  assert.equal(degraded.state, 'degraded');

  const failing = classifySilence(src({ lastEventAt: NOW - 10 * HOUR, consecutiveFailures: 5 }), NOW);
  assert.equal(failing.silent, false);
  assert.equal(failing.state, 'failing');
});

test('cooldown takes precedence over silence and failures', () => {
  const r = classifySilence(
    src({ lastEventAt: NOW - 10 * HOUR, consecutiveFailures: 9, cooldownUntil: NOW + 5 * MIN }),
    NOW,
  );
  assert.equal(r.state, 'cooldown');
  assert.equal(r.silent, false);
  // An expired cooldown does NOT short-circuit; failures classification resumes.
  const expired = classifySilence(
    src({ lastEventAt: NOW - 10 * HOUR, consecutiveFailures: 4, cooldownUntil: NOW - MIN }),
    NOW,
  );
  assert.equal(expired.state, 'failing');
});

test('never-emitted source with no failures stays healthy (warming up)', () => {
  const r = classifySilence(src({ lastEventAt: undefined }), NOW);
  assert.equal(r.silent, false);
  assert.equal(r.state, 'healthy');
});

// --- detectVolumeAnomaly ---------------------------------------------------

test('volume surge: high reading vs steady baseline trips a surge', () => {
  // mean 10/h, std 2 => z = (40-10)/2 = 15 >> threshold.
  const r = detectVolumeAnomaly(40, { mean: 10, std: 2, sampleCount: 50 });
  assert.equal(r.anomaly, true);
  assert.equal(r.direction, 'surge');
  assert.ok(r.z >= VOLUME_Z_THRESHOLD);
});

test('volume drop: feed quietly dies vs an established baseline', () => {
  // mean 20/h, std 3 => z = (0-20)/3 ≈ -6.67, |z| past threshold => drop.
  const r = detectVolumeAnomaly(0, { mean: 20, std: 3, sampleCount: 40 });
  assert.equal(r.anomaly, true);
  assert.equal(r.direction, 'drop');
  assert.ok(Math.abs(r.z) >= VOLUME_Z_THRESHOLD);
});

test('volume within normal range is not an anomaly', () => {
  // z = (13-10)/2 = 1.5 < threshold (3).
  const r = detectVolumeAnomaly(13, { mean: 10, std: 2, sampleCount: 30 });
  assert.equal(r.anomaly, false);
});

test('cold baseline (too few samples) never flags', () => {
  const r = detectVolumeAnomaly(100, { mean: 1, std: 1, sampleCount: MIN_BASELINE_SAMPLES - 1 });
  assert.equal(r.anomaly, false);
  assert.equal(r.z, 0);
});

test('zero/degenerate std never flags (no divide-by-zero)', () => {
  const r = detectVolumeAnomaly(50, { mean: 5, std: 0, sampleCount: 100 });
  assert.equal(r.anomaly, false);
  assert.equal(Number.isFinite(r.z), true);
  // omitted sampleCount defaults to "enough", but std=0 still guards.
  const r2 = detectVolumeAnomaly(50, { mean: 5, std: 0 });
  assert.equal(r2.anomaly, false);
});

// --- baselineStd (Welford population stddev) -------------------------------

test('baselineStd returns 0 below 2 samples and a real stddev otherwise', () => {
  assert.equal(baselineStd({ sourceId: 's', mean: 0, m2: 0, sampleCount: 0, updatedAt: NOW }), 0);
  assert.equal(baselineStd({ sourceId: 's', mean: 5, m2: 0, sampleCount: 1, updatedAt: NOW }), 0);
  // m2 = 8 over 2 samples => variance 4 => std 2.
  assert.equal(baselineStd({ sourceId: 's', mean: 5, m2: 8, sampleCount: 2, updatedAt: NOW }), 2);
});

test('detectVolumeAnomaly + baselineStd compose against a Welford baseline', () => {
  // Build a baseline by hand: samples [10,10,10,10,40] -> mean 16, then a 40
  // reading scored against the std should surge.
  // population variance of [10,10,10,10,40] = (sum (x-16)^2)/5
  //   = (36*4 + 576)/5 = (144+576)/5 = 720/5 = 144 -> std 12, mean 16.
  const std = baselineStd({ sourceId: 's', mean: 16, m2: 720, sampleCount: 5, updatedAt: NOW });
  assert.equal(std, 12);
  const r = detectVolumeAnomaly(60, { mean: 16, std, sampleCount: 5 });
  // sampleCount 5 < MIN_BASELINE_SAMPLES(8) so it should NOT flag despite z>3.
  assert.equal(r.anomaly, false);
});
