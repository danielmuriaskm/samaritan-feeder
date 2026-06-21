import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orderFrom, makeRotator, isRetryableStatus } from './keyPool.js';

test('orderFrom rotates to start at the given index', () => {
  const k = ['a', 'b', 'c'];
  assert.deepEqual(orderFrom(k, 0), ['a', 'b', 'c']);
  assert.deepEqual(orderFrom(k, 1), ['b', 'c', 'a']);
  assert.deepEqual(orderFrom(k, 2), ['c', 'a', 'b']);
  assert.deepEqual(orderFrom(k, 3), ['a', 'b', 'c']); // wraps
  assert.deepEqual(orderFrom(k, -1), ['c', 'a', 'b']); // negative
});

test('orderFrom edge cases', () => {
  assert.deepEqual(orderFrom([], 0), []);
  assert.deepEqual(orderFrom(['x'], 5), ['x']);
});

test('a rotator round-robins the start key across calls', () => {
  const rot = makeRotator();
  const k = ['a', 'b', 'c'];
  assert.deepEqual(rot(k), ['a', 'b', 'c']);
  assert.deepEqual(rot(k), ['b', 'c', 'a']);
  assert.deepEqual(rot(k), ['c', 'a', 'b']);
  assert.deepEqual(rot(k), ['a', 'b', 'c']); // wraps
});

test('separate rotators have INDEPENDENT cursors (chat vs embed)', () => {
  const a = makeRotator();
  const b = makeRotator();
  const k = ['x', 'y'];
  assert.deepEqual(a(k), ['x', 'y']); // a -> 0
  assert.deepEqual(a(k), ['y', 'x']); // a -> 1
  assert.deepEqual(b(k), ['x', 'y']); // b still at 0, unaffected by a
});

test('rotator is a no-op for 0/1 keys', () => {
  const rot = makeRotator();
  assert.deepEqual(rot([]), []);
  assert.deepEqual(rot(['only']), ['only']);
  assert.deepEqual(rot(['only']), ['only']);
});

test('isRetryableStatus: failover on quota/throttle/transient, not on auth/bad-request', () => {
  for (const s of [429, 402, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, `${s} retryable`);
  for (const s of [200, 400, 401, 403, 404]) assert.equal(isRetryableStatus(s), false, `${s} not retryable`);
});
