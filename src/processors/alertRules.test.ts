import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAlertRules, buildAlertText, hasPushSeverity } from './alertRules.js';
import type { AlertRule, CvAnalytics } from '../types.js';

function cv(partial: Partial<CvAnalytics>): CvAnalytics {
  return {
    counts: {},
    crowdDensity: 'empty',
    zones: [],
    lines: [],
    tracks: [],
    anomaly: { detected: false, reasons: [] },
    scene: { activityLevel: 'low' },
    model: 'test',
    framesAnalyzed: 1,
    ...partial,
  };
}

test('crowd_threshold fires on peak person count, not throughput', () => {
  const rules: AlertRule[] = [{ id: 'r1', type: 'crowd_threshold', threshold: 10 }];
  // 4 distinct person tracks (throughput) but peak 12 simultaneously -> fires.
  const firings = evaluateAlertRules(cv({ counts: { person: 4 }, peakPerson: 12 }), rules);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].value, 12);
});

test('zone_breach uses peak occupancy of the named zone', () => {
  const rules: AlertRule[] = [{ id: 'r1', type: 'zone_breach', zoneId: 'gate', threshold: 3 }];
  const fire = evaluateAlertRules(cv({ zones: [{ id: 'gate', occupancy: 1, peakOccupancy: 5 }] }), rules);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].value, 5);
  const noFire = evaluateAlertRules(cv({ zones: [{ id: 'gate', occupancy: 1, peakOccupancy: 2 }] }), rules);
  assert.equal(noFire.length, 0);
});

test('loitering uses max dwell of tracks that entered the zone', () => {
  const rules: AlertRule[] = [{ id: 'r1', type: 'loitering', zoneId: 'plaza', threshold: 60 }];
  const tracks = [
    { trackKey: 'a', label: 'person', topScore: 0.9, framesSeen: 5, firstSeenMs: 0, lastSeenMs: 1, zonesEntered: ['plaza'], edgeTouched: false, maxDwellSec: 72 },
    { trackKey: 'b', label: 'person', topScore: 0.9, framesSeen: 5, firstSeenMs: 0, lastSeenMs: 1, zonesEntered: ['other'], edgeTouched: false, maxDwellSec: 200 },
  ];
  const firings = evaluateAlertRules(cv({ tracks }), rules);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].value, 72); // the 'other'-zone 200s track is ignored
});

test('line_surge fires on in+out crossings', () => {
  const rules: AlertRule[] = [{ id: 'r1', type: 'line_surge', lineId: 'main', threshold: 10 }];
  const firings = evaluateAlertRules(cv({ lines: [{ id: 'main', in: 7, out: 4 }] }), rules);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].value, 11);
});

test('no rules -> no firings; severity + text are well-formed', () => {
  assert.deepEqual(evaluateAlertRules(cv({ peakPerson: 99 }), undefined), []);
  const firings = evaluateAlertRules(cv({ peakPerson: 30 }), [
    { id: 'r1', type: 'crowd_threshold', threshold: 25, severity: 'alert' },
  ]);
  assert.ok(hasPushSeverity(firings));
  assert.match(buildAlertText(firings), /crowd threshold \(30 >= 25\)/);
});

test('record-only (severity:detection) firings are not push-worthy', () => {
  const recordOnly = evaluateAlertRules(cv({ peakPerson: 30 }), [
    { id: 'r1', type: 'crowd_threshold', threshold: 25, severity: 'detection' },
  ]);
  assert.equal(recordOnly.length, 1);
  assert.equal(hasPushSeverity(recordOnly), false); // -> webcam emits no kind:'alert' push
  // mixed: one record-only + one push -> push-worthy overall
  const mixed = evaluateAlertRules(cv({ peakPerson: 30, lines: [{ id: 'L', in: 50, out: 0 }] }), [
    { id: 'r1', type: 'crowd_threshold', threshold: 25, severity: 'detection' },
    { id: 'r2', type: 'line_surge', lineId: 'L', threshold: 40, severity: 'alert' },
  ]);
  assert.equal(mixed.length, 2);
  assert.ok(hasPushSeverity(mixed));
});
