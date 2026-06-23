import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateRule,
  checkRuleValidity,
  type Rule,
  type ConvergenceEvent,
} from './ruleEngine.js';
import type { SourceKind, EventKind } from '../types.js';

const BASE = 1_700_000_000_000;

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

// --- collect + threshold (social_only_surge shape) --------------------------
test('threshold: a cluster meeting minCount fires; a smaller one does not', () => {
  const rule: Rule = {
    id: 'social_only_surge',
    version: 1,
    meta: { name: 'Social-only surge', risk: 'LOW' },
    collect: [
      { method: 'exact', field: 'sourceFamily', value: 'social' },
      { method: 'exists', field: 'tags.cluster_id' },
    ],
    aggregate: { field: 'tags.cluster_id' },
    analysis: { method: 'threshold', minCount: 3 },
    headline: 'Social-only surge in {field} ({metric})',
  };

  const events: ConvergenceEvent[] = [
    // cluster c1: 3 social members -> fires
    ev({ id: 'a', sourceKind: 'reddit', tags: { cluster_id: 'c1' } }),
    ev({ id: 'b', sourceKind: 'twitter', tags: { cluster_id: 'c1' } }),
    ev({ id: 'c', sourceKind: 'bluesky', tags: { cluster_id: 'c1' } }),
    // cluster c2: only 2 social members -> below threshold
    ev({ id: 'd', sourceKind: 'tiktok', tags: { cluster_id: 'c2' } }),
    ev({ id: 'e', sourceKind: 'reddit', tags: { cluster_id: 'c2' } }),
    // a wire event in c1 is filtered out by the sourceFamily matcher
    ev({ id: 'f', sourceKind: 'rss', tags: { cluster_id: 'c1' } }),
  ];

  const matches = evaluateRule(rule, events);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].groupKey, 'c1');
  assert.equal(matches[0].metric, 3);
  assert.deepEqual(matches[0].eventIds, ['a', 'b', 'c']); // 'f' (rss) excluded
});

// --- distinctField (hazard_cluster shape) -----------------------------------
test('threshold with distinctField counts distinct sources, not raw members', () => {
  const rule: Rule = {
    id: 'hazard_cluster',
    version: 1,
    meta: { name: 'Hazard convergence', risk: 'HIGH' },
    collect: [{ method: 'exact', field: 'sourceFamily', value: 'hazard_gov' }],
    aggregate: { field: 'geoCell' },
    analysis: { method: 'threshold', minCount: 2, distinctField: 'sourceKind' },
    headline: 'Hazards converging on {field}',
  };

  const loc = { lat: 34.2, lon: -118.3 };
  const events: ConvergenceEvent[] = [
    // same cell, 2 DISTINCT hazard feeds -> fires
    ev({ id: 'a', sourceKind: 'usgs', location: loc }),
    ev({ id: 'b', sourceKind: 'nws', location: { lat: 34.8, lon: -118.9 } }),
    // a different cell with 3 polls of ONE feed -> distinct sourceKind = 1 -> no fire
    ev({ id: 'c', sourceKind: 'gdacs', location: { lat: 10.5, lon: 10.5 } }),
    ev({ id: 'd', sourceKind: 'gdacs', location: { lat: 10.1, lon: 10.1 } }),
    ev({ id: 'e', sourceKind: 'gdacs', location: { lat: 10.9, lon: 10.9 } }),
    // a non-hazard event in the hot cell is filtered out by collect
    ev({ id: 'f', sourceKind: 'reddit', location: loc }),
  ];

  const matches = evaluateRule(rule, events);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].groupKey, '34:-119');
  assert.equal(matches[0].metric, 2); // 2 distinct sourceKinds
  assert.deepEqual(matches[0].sourceIds, ['src-a', 'src-b']);
});

// --- exact negation + list-OR ----------------------------------------------
test('exact matcher supports list-OR and a `not ` negation prefix', () => {
  const orRule: Rule = {
    id: 'or_rule',
    version: 1,
    meta: { name: 'or', risk: 'INFO' },
    collect: [{ method: 'exact', field: 'kind', value: ['visual', 'alert'] }],
    aggregate: { field: 'kind' },
    analysis: { method: 'threshold', minCount: 1 },
    headline: '{field}',
  };
  const events: ConvergenceEvent[] = [
    ev({ id: 'a', kind: 'visual' }),
    ev({ id: 'b', kind: 'alert' }),
    ev({ id: 'c', kind: 'text' }), // excluded
  ];
  const orMatches = evaluateRule(orRule, events);
  assert.equal(orMatches.reduce((n, m) => n + m.events.length, 0), 2);

  const notRule: Rule = { ...orRule, collect: [{ method: 'exact', field: 'kind', value: 'not text' }] };
  const notMatches = evaluateRule(notRule, events);
  // everything except the 'text' event survives
  assert.equal(notMatches.reduce((n, m) => n + m.events.length, 0), 2);
  for (const m of notMatches) assert.notEqual(m.groupKey, 'text');
});

// --- outlier (rare_country shape) -------------------------------------------
test('outlier flags a rare bucket and respects the minTotal guard', () => {
  const rule: Rule = {
    id: 'rare_country',
    version: 1,
    meta: { name: 'Rare country', risk: 'INFO' },
    collect: [{ method: 'exists', field: 'tags.country' }],
    aggregate: { field: 'tags.country' },
    analysis: { method: 'outlier', maximumPercent: 0.05, noisyPercent: 0.01, minTotal: 20 },
    headline: 'Rare country {field}',
  };

  // 24 'US' events + 1 'TV' (Tuvalu). Total 25; TV share = 4% <= 5% -> outlier.
  const events: ConvergenceEvent[] = [];
  for (let i = 0; i < 24; i++) events.push(ev({ id: `us${i}`, tags: { country: 'US' } }));
  events.push(ev({ id: 'tv', tags: { country: 'TV' } }));

  const matches = evaluateRule(rule, events);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].groupKey, 'TV');

  // Below minTotal -> no outliers at all.
  const thin = [ev({ id: 'us0', tags: { country: 'US' } }), ev({ id: 'tv', tags: { country: 'TV' } })];
  assert.equal(evaluateRule(rule, thin).length, 0);
});

// --- numeric comparator -----------------------------------------------------
test('gte matcher does a numeric comparison on a tags field', () => {
  const rule: Rule = {
    id: 'hot_score',
    version: 1,
    meta: { name: 'hot', risk: 'MEDIUM' },
    collect: [{ method: 'gte', field: 'tags.score', value: 0.8 }],
    aggregate: { field: 'kind' },
    analysis: { method: 'threshold', minCount: 1 },
    headline: '{field}',
  };
  const events: ConvergenceEvent[] = [
    ev({ id: 'a', kind: 'alert', tags: { score: 0.9 } }), // kept
    ev({ id: 'b', kind: 'text', tags: { score: 0.5 } }), // dropped
    ev({ id: 'c', kind: 'alert', tags: {} }), // no score -> dropped
  ];
  const total = evaluateRule(rule, events).reduce((n, m) => n + m.events.length, 0);
  assert.equal(total, 1);
});

// --- validation -------------------------------------------------------------
test('checkRuleValidity rejects malformed rules and accepts a good one', () => {
  assert.ok(checkRuleValidity(null).error);
  assert.ok(checkRuleValidity({ id: 'x' }).error); // no meta/collect/etc
  assert.ok(checkRuleValidity({ id: 'x', version: 2, meta: { name: 'n', risk: 'LOW' } }).error);
  assert.ok(
    checkRuleValidity({
      id: 'x',
      meta: { name: 'n', risk: 'NOPE' },
      collect: [{ method: 'exact', field: 'kind', value: 'text' }],
      aggregate: { field: 'kind' },
      analysis: { method: 'threshold', minCount: 1 },
      headline: 'h',
    }).error,
    'bad risk should be rejected',
  );

  const good = checkRuleValidity({
    id: 'good',
    version: 1,
    meta: { name: 'Good', risk: 'HIGH' },
    collect: [{ method: 'exact', field: 'sourceFamily', value: 'hazard_gov' }],
    aggregate: { field: 'geoCell' },
    analysis: { method: 'threshold', minCount: 2, distinctField: 'sourceKind' },
    headline: 'h {field}',
  });
  assert.equal(good.error, undefined);
  assert.equal(good.rule?.id, 'good');
  assert.equal(good.rule?.meta.risk, 'HIGH');
});
