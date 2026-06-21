import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time; provide the minimum so importing the
// module under test doesn't require a real database.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/test';
process.env.SAMARITAN_AUTH_TOKEN ??= 'test-token';

const { sanitizeCvResult, buildCvSummaryText, buildCvTitle, sanitizeEmbedding } = await import('./detection.js');

test('sanitizeCvResult keeps only anonymous aggregates and drops identity fields', () => {
  const malicious = {
    counts: { person: 3, car: '2', dog: 1 },
    crowd_density: 'moderate',
    zones: [{ id: 'a', occupancy: 2, peak_occupancy: 4 }],
    lines: [{ id: 'L1', in: 5, out: 1 }],
    anomaly: { detected: false, reasons: ['loitering', 'not_a_real_reason'] },
    scene: { activity_level: 'high' },
    model: 'rf-detr-nano',
    frames_analyzed: 1,
    // Fields a regressed sidecar must NOT be able to leak through:
    tracker_id: 42,
    tracks: [{ tracker_id: 7, embedding: [0.1, 0.2] }],
    plate: 'ABC-1234',
    descriptions: ['man wearing a red jacket'],
    faces: [{ id: 'face_1' }],
  };

  const cv = sanitizeCvResult(malicious);

  // Allowed aggregates survive (with coercion).
  assert.deepEqual(cv.counts, { person: 3, car: 2, dog: 1 });
  assert.equal(cv.crowdDensity, 'moderate');
  assert.deepEqual(cv.zones, [{ id: 'a', occupancy: 2, peakOccupancy: 4 }]);
  assert.deepEqual(cv.lines, [{ id: 'L1', in: 5, out: 1 }]);
  assert.deepEqual(cv.anomaly.reasons, ['loitering']); // unknown reason dropped
  assert.equal(cv.scene.activityLevel, 'high');

  // The malicious track had no valid label, so it is dropped entirely.
  assert.deepEqual(cv.tracks, []);

  // Identity-bearing fields are structurally absent — there is no channel for them.
  const serialized = JSON.stringify(cv);
  for (const forbidden of ['tracker_id', 'embedding', 'ABC-1234', 'red jacket', 'face_1']) {
    assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
  }
});

test('sanitizeCvResult keeps tracks as anonymous aggregates but strips raw identity', () => {
  const cv = sanitizeCvResult({
    counts: { car: 2 },
    tracks: [
      {
        track_key: 'a1b2c3d4e5f6',
        label: 'car',
        top_score: 0.91,
        frames_seen: 8,
        first_seen_ms: 1000,
        last_seen_ms: 4000,
        max_dwell_sec: 3,
        zones_entered: ['gate'],
        edge_touched: true,
        bbox_bucket: '4x5',
        // forbidden — must not survive:
        tracker_id: 7,
        embedding: [0.1, 0.2, 0.3],
        appearance: 'man in red',
        dedupe_key: 'ABC-1234 red sedan', // free-text channel must be ignored
      },
    ],
  });

  assert.equal(cv.tracks.length, 1);
  const t = cv.tracks[0];
  assert.equal(t.label, 'car');
  assert.equal(t.trackKey, 'a1b2c3d4e5f6');
  assert.equal(t.maxDwellSec, 3);
  assert.equal(t.bboxBucket, '4x5');
  assert.deepEqual(t.zonesEntered, ['gate']);
  // The raw tracker_id / embedding / appearance / free-text dedupe_key never
  // made it onto the object — there is no string channel for identity.
  const s = JSON.stringify(t);
  for (const forbidden of ['tracker_id', 'embedding', '"7"', 'man in red', 'appearance', 'ABC-1234', 'sedan']) {
    assert.ok(!s.includes(forbidden), `leaked: ${forbidden}`);
  }
  // trackKey is hex-only (opaque), never the raw integer id.
  assert.match(t.trackKey, /^[a-f0-9]+$/);
  // bboxBucket only accepts the strict "BXxBY" shape.
  assert.match(t.bboxBucket!, /^\d{1,2}x\d{1,2}$/);
});

test('sanitizeCvResult parses line per-class and clip metadata', () => {
  const cv = sanitizeCvResult({
    lines: [{ id: 'L1', name: 'main', in: 4, out: 2, per_class: { car: { in: 3, out: 1 }, 'abc-1234': { in: 9 } } }],
    clip_meta: { fps: 6, frames: 24, duration_sec: 4 },
  });
  assert.equal(cv.lines[0].name, 'main');
  assert.deepEqual(cv.lines[0].perClass, { car: { in: 3, out: 1 } }); // bad key dropped
  assert.deepEqual(cv.clip, { fps: 6, frames: 24, durationSec: 4 });
});

test('sanitizeCvResult rejects non-class-name counts keys (no plate smuggling)', () => {
  const cv = sanitizeCvResult({ counts: { person: 1, 'PLATE ABC1234': 1, 'weapon!': 2 } });
  assert.deepEqual(Object.keys(cv.counts), ['person']);
});

test('sanitizeCvResult falls back to safe defaults on garbage input', () => {
  const cv = sanitizeCvResult({ crowd_density: 'apocalyptic', scene: { activity_level: 'extreme' } });
  assert.equal(cv.crowdDensity, 'empty');
  assert.equal(cv.scene.activityLevel, 'low');
  assert.deepEqual(cv.counts, {});
  assert.equal(cv.framesAnalyzed, 1);
});

test('buildCvSummaryText is deterministic, ASCII, and PII-free', () => {
  const cv = sanitizeCvResult({
    counts: { car: 1, person: 3 },
    crowd_density: 'light',
    zones: [{ id: 'gate', occupancy: 2 }],
    lines: [{ id: 'L1', in: 4, out: 1 }],
    anomaly: { detected: false, reasons: [] },
    scene: { activity_level: 'medium' },
  });

  const text = buildCvSummaryText(cv);
  // Counts sorted by descending count: 3 people before 1 car.
  assert.match(text, /^3 people, 1 car/);
  assert.match(text, /zone gate occupancy 2/);
  assert.match(text, /line L1 in 4 out 1/);
  // Pure ASCII (filterLanguage relies on this).
  assert.ok([...text].every((c) => c.charCodeAt(0) < 128));
  // Same input -> same output.
  assert.equal(buildCvSummaryText(cv), text);
});

test('buildCvSummaryText handles the empty scene', () => {
  const cv = sanitizeCvResult({ counts: {}, crowd_density: 'empty' });
  assert.equal(buildCvSummaryText(cv), 'no people or vehicles detected');
});

test('sanitizeEmbedding accepts only a finite vector of the configured dimension', () => {
  const dim = 512; // CV_CLIP_DIM default
  const good = Array.from({ length: dim }, (_, i) => i / dim);
  assert.equal(sanitizeEmbedding(good)?.length, dim);
  assert.equal(sanitizeEmbedding(good.slice(0, 100)), undefined); // wrong length
  assert.equal(sanitizeEmbedding('not an array'), undefined);
  const withNaN = good.slice();
  withNaN[5] = NaN;
  assert.equal(sanitizeEmbedding(withNaN), undefined); // non-finite rejected
});

test('buildCvTitle prefixes anomalies and always sets a title (so filterContent passes)', () => {
  const normal = sanitizeCvResult({ counts: { person: 2 } });
  assert.equal(buildCvTitle(normal, 'Plaza Cam'), '2 people - Plaza Cam');

  const alert = sanitizeCvResult({ counts: { person: 40 }, anomaly: { detected: true, reasons: ['crowd'] } });
  assert.match(buildCvTitle(alert, 'Plaza Cam'), /^ALERT /);
});
