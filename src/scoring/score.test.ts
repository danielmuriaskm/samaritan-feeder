import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeScore } from './score.js';
import type { EventKind } from '../types.js';

function ev(partial: { kind?: EventKind; confidence?: number; tags?: Record<string, unknown>; eventAt?: number }) {
  return {
    kind: partial.kind ?? ('text' as EventKind),
    confidence: partial.confidence ?? 0.5,
    tags: partial.tags ?? {},
    eventAt: partial.eventAt ?? 0,
  };
}

const NOW = 1_000_000_000;

test('score is in [0,1] and components are present', () => {
  const { score, components } = computeScore({ event: ev({}), now: NOW });
  assert.ok(score >= 0 && score <= 1);
  for (const k of ['severity', 'threat', 'corroboration', 'sourceTrust', 'freshness', 'base'] as const) {
    assert.ok(components[k] >= 0 && components[k] <= 1, `${k} in range`);
  }
});

test('alert kind outranks plain text, all else equal', () => {
  const a = computeScore({ event: ev({ kind: 'alert', eventAt: NOW }), now: NOW }).score;
  const b = computeScore({ event: ev({ kind: 'text', eventAt: NOW }), now: NOW }).score;
  assert.ok(a > b);
});

test('threat enrichment raises the score', () => {
  const plain = computeScore({ event: ev({ eventAt: NOW }), now: NOW }).score;
  const malicious = computeScore({ event: ev({ tags: { vt_malicious: 9 }, eventAt: NOW }), now: NOW }).score;
  assert.ok(malicious > plain);
});

test('freshness decays with age (half-life 6h)', () => {
  const fresh = computeScore({ event: ev({ eventAt: NOW }), now: NOW }).components.freshness;
  const sixHoursOld = computeScore({ event: ev({ eventAt: NOW - 6 * 3600_000 }), now: NOW }).components.freshness;
  assert.ok(Math.abs(fresh - 1) < 1e-9);
  assert.ok(Math.abs(sixHoursOld - 0.5) < 1e-6);
});

test('corroboration: more independent sources => higher', () => {
  const one = computeScore({ event: ev({ eventAt: NOW }), now: NOW, corroboration: 1 }).components.corroboration;
  const eight = computeScore({ event: ev({ eventAt: NOW }), now: NOW, corroboration: 8 }).components.corroboration;
  assert.equal(one, 0);
  assert.ok(eight > 0.9);
});

test('record-only firings do NOT pin severity high', () => {
  const recordOnly = computeScore({
    event: ev({ kind: 'detection', tags: { alertFirings: [{ severity: 'detection' }] }, eventAt: NOW }),
    now: NOW,
  }).components.severity;
  const pushAlert = computeScore({
    event: ev({ kind: 'detection', tags: { alertFirings: [{ severity: 'alert' }] }, eventAt: NOW }),
    now: NOW,
  }).components.severity;
  assert.ok(pushAlert > recordOnly);
  assert.ok(pushAlert >= 0.9);
});
