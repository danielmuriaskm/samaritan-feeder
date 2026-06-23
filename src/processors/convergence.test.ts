import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  kindToFamily,
  detectSourceTypeConvergence,
  detectGeoConvergence,
  detectVelocitySpike,
  detectOutliers,
  detectSingleFamilyOnly,
  geoCell,
  scoreConvergence,
  type ConvergenceEvent,
} from './convergence.js';
import type { SourceKind, EventKind } from '../types.js';

const BASE = 1_700_000_000_000; // fixed clock for deterministic windows

function ev(p: Partial<ConvergenceEvent> & { id: string }): ConvergenceEvent {
  return {
    id: p.id,
    sourceId: p.sourceId ?? `src-${p.id}`,
    sourceKind: (p.sourceKind ?? 'rss') as SourceKind,
    kind: (p.kind ?? 'text') as EventKind,
    tags: p.tags ?? {},
    location: p.location,
    eventAt: p.eventAt ?? BASE,
  };
}

// --- kindToFamily -----------------------------------------------------------
test('kindToFamily collapses heterogeneous kinds into independence families', () => {
  assert.equal(kindToFamily('rss'), 'wire_news');
  assert.equal(kindToFamily('reddit'), 'social');
  assert.equal(kindToFamily('shodan'), 'osint_cyber');
  assert.equal(kindToFamily('traffic_cam'), 'camera_cv');
  assert.equal(kindToFamily('usgs'), 'hazard_gov');
  // Reddit + reddit_scrape are the SAME family — repeat polls don't corroborate.
  assert.equal(kindToFamily('reddit'), kindToFamily('reddit_scrape'));
});

// --- (a) source-type convergence -------------------------------------------
test('3 distinct families in a cluster fire; 2 families do not', () => {
  const threeFamilies = [
    ev({ id: 'a', sourceKind: 'rss', tags: { cluster_id: 'c1' } }),
    ev({ id: 'b', sourceKind: 'reddit', tags: { cluster_id: 'c1' } }),
    ev({ id: 'c', sourceKind: 'usgs', tags: { cluster_id: 'c1' } }),
  ];
  const fired = detectSourceTypeConvergence(threeFamilies);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].clusterId, 'c1');
  assert.deepEqual(fired[0].families, ['hazard_gov', 'social', 'wire_news']);
  assert.equal(fired[0].memberCount, 3);
  assert.ok(fired[0].score > 0);

  // Two families (even with three members) is NOT convergence.
  const twoFamilies = [
    ev({ id: 'd', sourceKind: 'rss', tags: { cluster_id: 'c2' } }),
    ev({ id: 'e', sourceKind: 'news_api', tags: { cluster_id: 'c2' } }), // also wire_news
    ev({ id: 'f', sourceKind: 'reddit', tags: { cluster_id: 'c2' } }),
  ];
  assert.equal(detectSourceTypeConvergence(twoFamilies).length, 0);
});

test('repeat polls of one family do not fabricate convergence', () => {
  // 5 reddit/social members, single cluster -> 1 family -> no fire.
  const social = ['a', 'b', 'c', 'd', 'e'].map((id) =>
    ev({ id, sourceKind: id < 'c' ? 'reddit' : 'twitter', tags: { cluster_id: 'cx' } }),
  );
  assert.equal(detectSourceTypeConvergence(social).length, 0);
});

test('events without cluster_id are ignored', () => {
  const noCluster = [
    ev({ id: 'a', sourceKind: 'rss' }),
    ev({ id: 'b', sourceKind: 'reddit' }),
    ev({ id: 'c', sourceKind: 'usgs' }),
  ];
  assert.equal(detectSourceTypeConvergence(noCluster).length, 0);
});

test('stale members outside the window are dropped before counting families', () => {
  const day = 24 * 60 * 60 * 1000;
  const events = [
    ev({ id: 'a', sourceKind: 'rss', tags: { cluster_id: 'c1' }, eventAt: BASE }),
    ev({ id: 'b', sourceKind: 'reddit', tags: { cluster_id: 'c1' }, eventAt: BASE - 1000 }),
    // hazard_gov member is 3 days old -> outside the 24h window -> family lost.
    ev({ id: 'c', sourceKind: 'usgs', tags: { cluster_id: 'c1' }, eventAt: BASE - 3 * day }),
  ];
  assert.equal(detectSourceTypeConvergence(events, { windowMs: day }).length, 0);
  // Widen the window and it fires again.
  assert.equal(detectSourceTypeConvergence(events, { windowMs: 7 * day }).length, 1);
});

test('source convergence reports sorted, deduped source/event ids', () => {
  const events = [
    ev({ id: 'e2', sourceId: 's2', sourceKind: 'rss', tags: { cluster_id: 'c1' } }),
    ev({ id: 'e1', sourceId: 's1', sourceKind: 'reddit', tags: { cluster_id: 'c1' } }),
    ev({ id: 'e3', sourceId: 's3', sourceKind: 'shodan', tags: { cluster_id: 'c1' } }),
  ];
  const [conv] = detectSourceTypeConvergence(events);
  assert.deepEqual(conv.eventIds, ['e1', 'e2', 'e3']);
  assert.deepEqual(conv.sourceIds, ['s1', 's2', 's3']);
});

// --- score monotonicity -----------------------------------------------------
test('scoreConvergence is in 0..1, diversity dominates volume', () => {
  const lowDivHighVol = scoreConvergence(2, 40);
  const highDivLowVol = scoreConvergence(4, 4);
  assert.ok(highDivLowVol > lowDivHighVol);
  for (const [d, m] of [[3, 3], [5, 50], [1, 1]] as const) {
    const s = scoreConvergence(d, m);
    assert.ok(s >= 0 && s <= 1);
  }
});

// --- (b) geo convergence ----------------------------------------------------
test('geoCell bins to ~1-degree cells and centers the cell', () => {
  const { key, center } = geoCell(40.7, -74.0);
  assert.equal(key, '40:-74');
  assert.equal(center.lat, 40.5);
  assert.equal(center.lon, -73.5);
  // Two nearby points share a cell.
  assert.equal(geoCell(40.1, -74.9).key, geoCell(40.9, -74.1).key);
});

test('3 distinct event KINDS co-located in a cell fire geo convergence', () => {
  const loc = { lat: 34.2, lon: -118.3 };
  const events = [
    ev({ id: 'a', kind: 'visual', location: loc }),
    ev({ id: 'b', kind: 'text', location: { lat: 34.8, lon: -118.9 } }), // same cell
    ev({ id: 'c', kind: 'alert', location: { lat: 34.1, lon: -118.1 } }), // same cell
  ];
  const fired = detectGeoConvergence(events);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].kinds, ['alert', 'text', 'visual']);
  assert.equal(fired[0].center.lat, 34.5);
  assert.equal(fired[0].center.lon, -118.5);
});

test('same kind repeated in a cell does NOT fire geo convergence', () => {
  const events = ['a', 'b', 'c'].map((id) =>
    ev({ id, kind: 'visual', location: { lat: 51.5, lon: -0.1 } }),
  );
  assert.equal(detectGeoConvergence(events).length, 0);
});

test('events in different cells do not co-occur', () => {
  const events = [
    ev({ id: 'a', kind: 'visual', location: { lat: 10.5, lon: 10.5 } }),
    ev({ id: 'b', kind: 'text', location: { lat: 20.5, lon: 20.5 } }),
    ev({ id: 'c', kind: 'alert', location: { lat: 30.5, lon: 30.5 } }),
  ];
  assert.equal(detectGeoConvergence(events).length, 0);
});

test('events without location are skipped in geo convergence', () => {
  const events = [
    ev({ id: 'a', kind: 'visual', location: { lat: 0.5, lon: 0.5 } }),
    ev({ id: 'b', kind: 'text' }),
    ev({ id: 'c', kind: 'alert' }),
  ];
  assert.equal(detectGeoConvergence(events).length, 0);
});

// --- (c) velocity spike -----------------------------------------------------
test('velocity spike fires above 3x baseline, not at or below', () => {
  const baseline = (id: string) => (id === 'hot' ? 2 : 5);
  const counts = new Map<string, number>([
    ['hot', 7], // 7 / 2 = 3.5x -> fire
    ['warm', 10], // 10 / 5 = 2x -> no fire
  ]);
  const spikes = detectVelocitySpike(counts, baseline);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].clusterId, 'hot');
  assert.equal(spikes[0].ratio, 3.5);
  assert.ok(spikes[0].score >= 0.5 && spikes[0].score <= 1);
});

test('velocity spike ignores clusters below the absolute minimum and zero baselines', () => {
  const counts = new Map<string, number>([
    ['tiny', 2], // below minCurrent default (=multiple=3) even though 2/0.1 is huge
    ['nobase', 9],
  ]);
  const baseline = (id: string) => (id === 'tiny' ? 0.1 : 0);
  assert.equal(detectVelocitySpike(counts, baseline).length, 0);
});

test('velocity spikes are returned strongest-ratio first', () => {
  const counts = new Map<string, number>([['a', 6], ['b', 12]]);
  const spikes = detectVelocitySpike(counts, () => 1, { minCurrent: 1 });
  assert.equal(spikes.length, 2);
  assert.equal(spikes[0].clusterId, 'b'); // 12x before 6x
});

// --- (d) outlier / rarity ---------------------------------------------------
test('detectOutliers flags a rare country bucket and ignores noisy/small data', () => {
  // 19 events from common countries + 1 rare => the rare one is <=10% share.
  const events: ConvergenceEvent[] = [];
  for (let i = 0; i < 18; i++) events.push(ev({ id: `us${i}`, tags: { country: 'US' } }));
  events.push(ev({ id: 'gb', tags: { country: 'GB' } }));
  events.push(ev({ id: 'kp', tags: { country: 'KP' } })); // the rare one (1/20 = 5%)

  const outliers = detectOutliers(events, { axes: ['country'] });
  const kp = outliers.find((o) => o.bucketKey === 'KP');
  assert.ok(kp, 'rare country should be flagged');
  assert.ok(kp!.score > 0);
  // The dominant US bucket (90%) must never be an outlier.
  assert.equal(outliers.some((o) => o.bucketKey === 'US'), false);

  // Below the minimum total, nothing fires (too little data to call rarity).
  assert.equal(detectOutliers(events.slice(0, 5), { axes: ['country'] }).length, 0);
});

// --- (e) single-family / uncorroborated -------------------------------------
test('detectSingleFamilyOnly needs a real social cluster, not a lone post', () => {
  // A single social post in a cluster must NOT fire (the singleton-noise floor).
  const lone = [ev({ id: 's1', sourceKind: 'reddit', tags: { cluster_id: 'c1' } })];
  assert.equal(detectSingleFamilyOnly(lone).length, 0);

  // 3 social posts, all same family, no wire/gov => fires as uncorroborated.
  const socialOnly = [
    ev({ id: 's2', sourceKind: 'reddit', tags: { cluster_id: 'c2' } }),
    ev({ id: 's3', sourceKind: 'twitter', tags: { cluster_id: 'c2' } }),
    ev({ id: 's4', sourceKind: 'bluesky', tags: { cluster_id: 'c2' } }),
  ];
  const fired = detectSingleFamilyOnly(socialOnly);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].clusterId, 'c2');
  assert.deepEqual(fired[0].families, ['social']);

  // The same cluster corroborated by a wire item is NOT uncorroborated.
  const corroborated = [
    ...socialOnly,
    ev({ id: 'w1', sourceKind: 'rss', tags: { cluster_id: 'c2' } }),
  ];
  assert.equal(detectSingleFamilyOnly(corroborated).length, 0);
});
