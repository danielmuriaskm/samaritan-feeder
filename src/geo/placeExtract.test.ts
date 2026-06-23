import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractPlace } from './placeExtract.js';

test('extracts a "<City>, <Country>" pair with high confidence', () => {
  const got = extractPlace('Heavy shelling reported in Kharkiv, Ukraine overnight');
  assert.ok(got, 'expected a candidate');
  assert.equal(got!.name, 'Kharkiv, Ukraine');
  assert.ok(got!.confidence >= 0.8, `confidence ${got!.confidence} should be high`);
});

test('the comma pair outranks a bare preposition cue', () => {
  // "near Mosul" (preposition) vs "Erbil, Iraq" (comma pair) — pair should win.
  const got = extractPlace('Clashes near Mosul as forces regroup in Erbil, Iraq');
  assert.ok(got);
  assert.equal(got!.name, 'Erbil, Iraq');
});

test('falls back to a preposition cue when no comma pair exists', () => {
  const got = extractPlace('Flooding reported near Valencia after record rainfall');
  assert.ok(got);
  assert.equal(got!.name, 'Valencia');
  assert.ok(got!.confidence > 0 && got!.confidence < 0.9);
});

test('returns undefined when there is no location signal', () => {
  assert.equal(extractPlace('Markets rally as inflation cools'), undefined);
  assert.equal(extractPlace(), undefined);
  assert.equal(extractPlace('', ''), undefined);
});

test('rejects capitalized non-places (months/weekdays/filler)', () => {
  // "in January" and "in Breaking" are capitalized runs but stop-words only.
  assert.equal(extractPlace('Big announcement coming in January'), undefined);
  assert.equal(extractPlace('Breaking: vote scheduled for Monday'), undefined);
});

test('title outweighs body for the chosen candidate', () => {
  const got = extractPlace('Explosion in Beirut, Lebanon', 'Earlier seen near Tripoli');
  assert.ok(got);
  assert.equal(got!.name, 'Beirut, Lebanon');
});
