import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectFields, budgetText, shapeToolResult, getPath } from './shape.js';

// ── getPath / projectFields ─────────────────────────────────────────────────

test('getPath resolves dot-paths and returns undefined for missing segments', () => {
  const obj = { a: { b: { c: 7 } }, x: 1 };
  assert.equal(getPath(obj, 'a.b.c'), 7);
  assert.equal(getPath(obj, 'x'), 1);
  assert.equal(getPath(obj, 'a.b.zzz'), undefined);
  assert.equal(getPath(obj, 'a.missing.c'), undefined); // walks through null safely
  assert.equal(getPath(null, 'a.b'), undefined);
});

test('projectFields picks a subset, flattening dot-paths and omitting missing keys', () => {
  const ev = {
    id: 'e1',
    kind: 'alert',
    content: 'flood warning',
    location: { lat: 1.5, lon: -2.5 },
    secret: 'do-not-leak',
  };
  const out = projectFields(ev, ['id', 'kind', 'location.lat', 'missing.path']) as Record<string, unknown>;
  assert.deepEqual(out, { id: 'e1', kind: 'alert', 'location.lat': 1.5 });
  // missing.path is absent (not null), and unrequested `secret`/`content` are dropped.
  assert.equal('missing.path' in out, false);
  assert.equal('secret' in out, false);
});

test('projectFields with no fields returns the object unchanged', () => {
  const ev = { id: 'e1', n: 2 };
  assert.equal(projectFields(ev), ev);
  assert.equal(projectFields(ev, []), ev);
});

test('projectFields leaves non-objects (and arrays) untouched', () => {
  assert.equal(projectFields('hi', ['id']), 'hi');
  assert.equal(projectFields(42, ['id']), 42);
  const arr = [1, 2];
  assert.equal(projectFields(arr, ['0']), arr);
});

// ── budgetText ──────────────────────────────────────────────────────────────

test('budgetText returns text unchanged when within budget (boundary)', () => {
  const s = 'abcde';
  assert.equal(budgetText(s, 5), s); // exactly at limit, no marker
  assert.equal(budgetText(s, 6), s);
});

test('budgetText truncates with an honest "...(N more)" marker and respects the cap', () => {
  const s = 'a'.repeat(100);
  const out = budgetText(s, 30);
  assert.ok(out.length <= 30, `expected <=30, got ${out.length}`);
  assert.match(out, /\.\.\.\(\d+ more\)$/);
  // The reported drop count + kept body must equal the original length.
  const m = out.match(/\.\.\.\((\d+) more\)$/);
  assert.ok(m);
  const dropped = Number(m![1]);
  const keptBody = out.length - m![0].length;
  assert.equal(keptBody + dropped, s.length);
});

test('budgetText handles non-positive and tiny budgets', () => {
  assert.equal(budgetText('hello', 0), '');
  assert.equal(budgetText('hello', -5), '');
  // Budget smaller than the marker: return just the (honest) marker.
  const out = budgetText('hello world', 3);
  assert.match(out, /more\)$/);
});

// ── shapeToolResult ─────────────────────────────────────────────────────────

test('shapeToolResult caps items and appends a "(+N more items)" marker', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, junk: 'x'.repeat(50) }));
  const out = shapeToolResult(rows, { fields: ['id'], maxItems: 3, maxChars: 5000 });
  assert.match(out, /\(\+7 more items\)/);
  // Only the projected `id` field survives; the junk field is gone.
  assert.equal(out.includes('junk'), false);
  assert.ok(out.includes('"e0"') && out.includes('"e2"'));
  assert.equal(out.includes('"e3"'), false); // beyond the item cap
});

test('shapeToolResult emits [] for an empty list and never adds a marker', () => {
  assert.equal(shapeToolResult([], { fields: ['id'] }), '[]');
});

test('shapeToolResult honors the char budget on top of the item cap', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, blob: 'y'.repeat(200) }));
  const out = shapeToolResult(rows, { fields: ['id', 'blob'], maxItems: 5, maxChars: 120 });
  assert.ok(out.length <= 120, `expected <=120, got ${out.length}`);
  assert.match(out, /\.\.\.\(\d+ more\)$/);
});

test('shapeToolResult with no fields keeps full objects but still caps items', () => {
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const out = shapeToolResult(rows, { maxItems: 2, maxChars: 5000 });
  assert.match(out, /\(\+1 more items\)/);
  assert.ok(out.includes('"a": 1'));
});
