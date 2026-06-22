import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  orderAndCap,
  extractProperNouns,
  validateNoHallucinatedProperNouns,
  checkLeadGrounding,
  deterministicBrief,
} from './briefSynth.js';
import type { IntelligenceEvent } from '../types.js';

function ev(partial: Partial<IntelligenceEvent>): IntelligenceEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    sourceId: partial.sourceId ?? 'src',
    kind: partial.kind ?? 'text',
    title: partial.title,
    content: partial.content ?? '',
    confidence: partial.confidence ?? 0.5,
    sensitivity: 'public',
    tags: partial.tags ?? {},
    location: partial.location,
    eventAt: partial.eventAt ?? Date.now(),
    createdAt: Date.now(),
    score: partial.score,
  };
}

// ---------------------------------------------------------------------------
// orderAndCap: dedup by cluster, per-source cap, score ordering.
// ---------------------------------------------------------------------------

test('orderAndCap dedups by cluster keeping the highest-scored member', () => {
  const events = [
    ev({ id: 'a', score: 0.6, tags: { clusterId: 'c1' } }),
    ev({ id: 'b', score: 0.9, tags: { clusterId: 'c1' } }), // strongest of c1
    ev({ id: 'c', score: 0.7, tags: { clusterId: 'c2' } }),
    ev({ id: 'd', score: 0.5 }), // no cluster -> singleton, always kept
  ];
  const out = orderAndCap(events, { maxPerSource: 10 });
  const ids = out.map((e) => e.id);
  assert.deepEqual(ids, ['b', 'c', 'd']); // 'a' collapsed into 'b'; ordered by score
});

test('orderAndCap collapses the same alert across overlapping feeds (no cluster tag)', () => {
  // Same real-world NWS alert ingested by two feeds (different sourceId/id) and
  // re-issued once — identical kind+title+content but no clusterId tag. Should
  // collapse to ONE representative (highest score) despite differing source/id.
  const title = 'NWS Severe Flood Warning';
  const content = 'Flood Warning issued for Some County. Severity: Severe. Move to higher ground.';
  const events = [
    ev({ id: 'tornado-feed', sourceId: 'seed-nws-tornado', score: 0.7, title, content }),
    ev({ id: 'severe-feed', sourceId: 'seed-nws-severe', score: 0.9, title, content }), // strongest
    ev({ id: 'reissue', sourceId: 'seed-nws-severe', score: 0.6, title, content }),
    ev({ id: 'other', sourceId: 'seed-nws-severe', score: 0.5, title: 'Different Heat Advisory', content: 'Heat.' }),
  ];
  const out = orderAndCap(events, { maxPerSource: 10 });
  assert.deepEqual(out.map((e) => e.id), ['severe-feed', 'other']);
});

test('orderAndCap caps per source', () => {
  const events = [
    ev({ id: '1', sourceId: 's', score: 0.9 }),
    ev({ id: '2', sourceId: 's', score: 0.8 }),
    ev({ id: '3', sourceId: 's', score: 0.7 }),
    ev({ id: '4', sourceId: 's', score: 0.6 }), // dropped: 4th from same source
    ev({ id: '5', sourceId: 'other', score: 0.55 }),
  ];
  const out = orderAndCap(events, { maxPerSource: 3 });
  const ids = out.map((e) => e.id);
  assert.deepEqual(ids, ['1', '2', '3', '5']);
});

test('orderAndCap orders by score then recency, honoring limit', () => {
  const events = [
    ev({ id: 'lo', score: 0.2 }),
    ev({ id: 'hi', score: 0.95 }),
    ev({ id: 'mid', score: 0.5 }),
  ];
  const out = orderAndCap(events, { maxPerSource: 10, limit: 2 });
  assert.deepEqual(out.map((e) => e.id), ['hi', 'mid']);
});

test('orderAndCap falls back to confidence when score is absent', () => {
  const events = [
    ev({ id: 'a', confidence: 0.3 }),
    ev({ id: 'b', confidence: 0.8 }),
  ];
  assert.deepEqual(orderAndCap(events).map((e) => e.id), ['b', 'a']);
});

// ---------------------------------------------------------------------------
// extractProperNouns.
// ---------------------------------------------------------------------------

test('extractProperNouns finds multi-word entities and acronyms, skips common words', () => {
  const nouns = extractProperNouns('The USGS reported a quake near San Francisco today.');
  const lc = nouns.map((n) => n.toLowerCase());
  assert.ok(lc.includes('usgs'));
  assert.ok(lc.some((n) => n.includes('san francisco')));
  // "The" / "today" are not entities.
  assert.ok(!lc.includes('the'));
});

// ---------------------------------------------------------------------------
// validateNoHallucinatedProperNouns: fabrication is caught.
// ---------------------------------------------------------------------------

test('rejects an LLM proper noun absent from the sources', () => {
  const source = 'USGS reported a magnitude 5.2 earthquake near San Francisco.';
  const fabricated = 'Officials in Tokyo confirmed the San Francisco earthquake.'; // Tokyo invented
  assert.equal(validateNoHallucinatedProperNouns(fabricated, source), false);
});

test('accepts an LLM output whose entities all trace to the sources', () => {
  const source = 'USGS reported a magnitude 5.2 earthquake near San Francisco.';
  const grounded = 'San Francisco hit by a magnitude 5.2 quake, USGS says.';
  assert.equal(validateNoHallucinatedProperNouns(grounded, source), true);
});

test('acronym/case normalization grounds U.S.A. against USA', () => {
  const source = 'The USA issued a new advisory.';
  const draft = 'A new advisory from the U.S.A.';
  assert.equal(validateNoHallucinatedProperNouns(draft, source), true);
});

test('multi-word source entity grounds a reordered output entity', () => {
  const source = 'New York City declared an emergency.';
  // model re-cases / shortens; component words are grounded.
  const draft = 'Emergency declared in New York.';
  assert.equal(validateNoHallucinatedProperNouns(draft, source), true);
});

// ---------------------------------------------------------------------------
// checkLeadGrounding.
// ---------------------------------------------------------------------------

test('lead grounding requires shared anchors with the sources', () => {
  const sources = ['USGS reported a magnitude 5.2 earthquake near San Francisco.'];
  assert.equal(checkLeadGrounding('San Francisco rattled by a 5.2 earthquake.', sources), true);
  // Names only un-grounded entities and no shared number -> rejected.
  assert.equal(checkLeadGrounding('Berlin markets opened higher on Tuesday.', sources), false);
});

test('lead grounding accepts a purely numeric anchor match', () => {
  const sources = ['A convoy of 250 vehicles was observed.'];
  assert.equal(checkLeadGrounding('Roughly 250 vehicles seen moving overnight.', sources), true);
});

test('lead grounding accepts when there are no anchors to validate against', () => {
  assert.equal(checkLeadGrounding('anything goes here', ['lowercase prose with no entities']), true);
});

// ---------------------------------------------------------------------------
// deterministicBrief: always-valid fallback.
// ---------------------------------------------------------------------------

test('deterministicBrief builds a lead from the strongest event and lists all', () => {
  const events = [
    ev({ id: 'a', title: 'Quake near coast', score: 0.9 }),
    ev({ id: 'b', title: 'Storm forming', score: 0.6 }),
  ];
  const det = deterministicBrief(events);
  assert.match(det.lead, /Quake near coast/);
  assert.match(det.lead, /\+1 more/);
  assert.deepEqual(det.body.rankedEventIds, ['a', 'b']);
});

test('deterministicBrief handles the empty window', () => {
  const det = deterministicBrief([]);
  assert.equal(det.body.rankedEventIds?.length, 0);
  assert.ok(det.lead.length > 0);
});
