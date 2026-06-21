import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trustForSource, trustForKind } from './sourceTrust.js';

test('authoritative kinds outrank social and scraped', () => {
  assert.ok(trustForKind('usgs') > trustForKind('reddit'));
  assert.ok(trustForKind('reddit') > trustForKind('reddit_scrape'));
  assert.ok(trustForKind('shodan') > trustForKind('webcrawl'));
});

test('explicit config.trust (0..1) wins', () => {
  assert.equal(trustForSource({ kind: 'webcrawl', config: { trust: 0.95 } }), 0.95);
  // out-of-range is ignored, falls back to tier
  assert.equal(trustForSource({ kind: 'usgs', config: { trust: 5 } }), trustForKind('usgs'));
});

test('config.trustTier override maps to the tier trust', () => {
  assert.equal(trustForSource({ kind: 'twitter_scrape', config: { trustTier: 1 } }), trustForKind('usgs'));
});

test('falls back to kind tier with no override', () => {
  assert.equal(trustForSource({ kind: 'rss', config: {} }), trustForKind('rss'));
});
