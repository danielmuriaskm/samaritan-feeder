import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextCooldownUntil, isInCooldown } from './circuitBreaker.js';

test('below threshold => no cooldown (keep polling)', () => {
  assert.equal(nextCooldownUntil(0, 1000), undefined);
  assert.equal(nextCooldownUntil(2, 1000, { failureThreshold: 3 }), undefined);
});

test('at threshold => base cooldown; then doubles', () => {
  const now = 1_000_000;
  const cfg = { failureThreshold: 3, baseMs: 1000, maxMs: 100_000 };
  assert.equal(nextCooldownUntil(3, now, cfg), now + 1000); // step 0
  assert.equal(nextCooldownUntil(4, now, cfg), now + 2000); // step 1
  assert.equal(nextCooldownUntil(5, now, cfg), now + 4000); // step 2
});

test('cooldown is capped at maxMs', () => {
  const now = 0;
  const cfg = { failureThreshold: 1, baseMs: 1000, maxMs: 3000 };
  assert.equal(nextCooldownUntil(50, now, cfg), now + 3000);
});

test('isInCooldown respects null/absent and the boundary', () => {
  assert.equal(isInCooldown({ cooldownUntil: null }, 100), false);
  assert.equal(isInCooldown({}, 100), false);
  assert.equal(isInCooldown({ cooldownUntil: 200 }, 100), true);
  assert.equal(isInCooldown({ cooldownUntil: 100 }, 100), false); // now === until => expired
});
