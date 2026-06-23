import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aoiScore, aoiTag } from './aoi.js';
import type { AoiEvent } from './aoi.js';
import type { AoiRule } from '../store/aoi.js';

function rule(partial: Partial<AoiRule> & Pick<AoiRule, 'kind' | 'definition'>): AoiRule {
  return {
    id: partial.id ?? 'r1',
    name: partial.name ?? 'test rule',
    kind: partial.kind,
    definition: partial.definition,
    weight: partial.weight ?? 1.0,
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? 0,
  };
}

function ev(partial: Partial<AoiEvent>): AoiEvent {
  return {
    tags: partial.tags ?? {},
    location: partial.location,
    title: partial.title,
    content: partial.content,
  };
}

test('no rules => no match, zero score', () => {
  const r = aoiScore(ev({ content: 'anything' }), []);
  assert.equal(r.matched, false);
  assert.equal(r.score, 0);
  assert.deepEqual(r.matchedRuleIds, []);
  assert.equal(aoiTag(r), undefined);
});

test('geo_bbox: point inside the box matches, outside does not', () => {
  const box = rule({
    id: 'bbox',
    kind: 'geo_bbox',
    definition: { minLat: 40, minLon: -75, maxLat: 41, maxLon: -73 },
  });
  const inside = aoiScore(ev({ location: { lat: 40.7, lon: -74 } }), [box]);
  assert.ok(inside.matched);
  assert.deepEqual(inside.matchedRuleIds, ['bbox']);
  assert.equal(aoiTag(inside), 'in_aoi');

  const outside = aoiScore(ev({ location: { lat: 0, lon: 0 } }), [box]);
  assert.equal(outside.matched, false);

  // no location at all => no match
  assert.equal(aoiScore(ev({}), [box]).matched, false);
});

test('geo_radius: within radius matches, beyond does not', () => {
  // Center NYC; ~same point is well within 50km, London is not.
  const r = rule({ kind: 'geo_radius', definition: { lat: 40.71, lon: -74.0, radiusKm: 50 } });
  assert.ok(aoiScore(ev({ location: { lat: 40.73, lon: -73.99 } }), [r]).matched);
  assert.equal(aoiScore(ev({ location: { lat: 51.5, lon: -0.12 } }), [r]).matched, false);
});

test('country: case-insensitive ISO2 membership against tags.country', () => {
  const r = rule({ kind: 'country', definition: { codes: ['US', 'CA'] } });
  assert.ok(aoiScore(ev({ tags: { country: 'us' } }), [r]).matched);
  assert.ok(aoiScore(ev({ tags: { country: 'CA' } }), [r]).matched);
  assert.equal(aoiScore(ev({ tags: { country: 'FR' } }), [r]).matched, false);
});

test('region: membership against tags.region', () => {
  const r = rule({ kind: 'region', definition: { regions: ['MENA'] } });
  assert.ok(aoiScore(ev({ tags: { region: 'MENA' } }), [r]).matched);
  assert.equal(aoiScore(ev({ tags: { region: 'EU' } }), [r]).matched, false);
});

test('entity: matches string and object entities in tags.entities', () => {
  const r = rule({ kind: 'entity', definition: { values: ['ACME Corp'] } });
  assert.ok(aoiScore(ev({ tags: { entities: ['ACME Corp', 'Other'] } }), [r]).matched);
  assert.ok(aoiScore(ev({ tags: { entities: [{ value: 'acme corp' }] } }), [r]).matched);
  assert.equal(aoiScore(ev({ tags: { entities: ['Nope'] } }), [r]).matched, false);
});

test('domain: exact and subdomain match against tags.domain / tags.domains', () => {
  const r = rule({ kind: 'domain', definition: { domains: ['example.com'] } });
  assert.ok(aoiScore(ev({ tags: { domain: 'example.com' } }), [r]).matched);
  assert.ok(aoiScore(ev({ tags: { domain: 'mail.example.com' } }), [r]).matched);
  assert.ok(aoiScore(ev({ tags: { domains: ['foo.bar', 'api.example.com'] } }), [r]).matched);
  // not a suffix match (notexample.com must NOT match example.com)
  assert.equal(aoiScore(ev({ tags: { domain: 'notexample.com' } }), [r]).matched, false);
});

test('keyword: case-insensitive substring across title + content', () => {
  const r = rule({ kind: 'keyword', definition: { keywords: ['ransomware'] } });
  assert.ok(aoiScore(ev({ title: 'New RANSOMWARE strain' }), [r]).matched);
  assert.ok(aoiScore(ev({ content: 'detailed ransomware analysis' }), [r]).matched);
  assert.equal(aoiScore(ev({ title: 'unrelated', content: 'news' }), [r]).matched, false);
});

test('disabled rules are skipped', () => {
  const r = rule({ kind: 'keyword', definition: { keywords: ['hit'] }, enabled: false });
  assert.equal(aoiScore(ev({ content: 'a hit here' }), [r]).matched, false);
});

test('score: single match uses its weight; clamped to 0..1', () => {
  const half = rule({ id: 'a', kind: 'keyword', definition: { keywords: ['x'] }, weight: 0.5 });
  assert.equal(aoiScore(ev({ content: 'x' }), [half]).score, 0.5);

  const over = rule({ id: 'b', kind: 'keyword', definition: { keywords: ['x'] }, weight: 3 });
  assert.equal(aoiScore(ev({ content: 'x' }), [over]).score, 1);
});

test('score: multiple matches sum but clamp at 1; ids collected in order', () => {
  const a = rule({ id: 'a', kind: 'keyword', definition: { keywords: ['x'] }, weight: 0.4 });
  const b = rule({ id: 'b', kind: 'country', definition: { codes: ['US'] }, weight: 0.4 });
  const c = rule({ id: 'c', kind: 'region', definition: { regions: ['EU'] }, weight: 0.4 });
  const res = aoiScore(ev({ content: 'x', tags: { country: 'US', region: 'EU' } }), [a, b, c]);
  assert.ok(res.matched);
  assert.deepEqual(res.matchedRuleIds, ['a', 'b', 'c']);
  // sum would be 1.2 -> clamped to 1
  assert.equal(res.score, 1);
});
