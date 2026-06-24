import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guessEntityType, normalizeEntityType } from './entities.js';
import { isLowValueEntity } from '../processors/entityExtract.js';

// guessEntityType — the fix that stopped the graph being a wall of blue.
test('guessEntityType detects structured values; bare names default to org (not domain)', () => {
  assert.equal(guessEntityType('1.2.3.4'), 'ipv4');
  assert.equal(guessEntityType('CVE-2024-1234'), 'cve');
  assert.equal(guessEntityType('a@b.com'), 'email');
  assert.equal(guessEntityType('github.com'), 'domain'); // a real dotted hostname stays a domain
  assert.equal(guessEntityType('OpenAI'), 'org'); // bare name -> org (was 'domain')
  assert.equal(guessEntityType('France'), 'org');
});

// normalizeEntityType — fold LLM-supplied types onto the controlled vocabulary.
test('normalizeEntityType maps LLM types onto org/person/place/product/tech', () => {
  assert.equal(normalizeEntityType('company', 'OpenAI'), 'org');
  assert.equal(normalizeEntityType('country', 'France'), 'place');
  assert.equal(normalizeEntityType('software', 'Claude'), 'product');
  assert.equal(normalizeEntityType('framework', 'React'), 'tech');
  assert.equal(normalizeEntityType('person', 'Jane Doe'), 'person');
  assert.equal(normalizeEntityType('domain', 'x.com'), 'domain'); // structured passes through
  assert.equal(normalizeEntityType('ip', '1.2.3.4'), 'ipv4'); // loose alias
  assert.equal(normalizeEntityType('totally-unknown', 'OpenAI'), 'org'); // falls back to guess -> org
});

// isLowValueEntity — the graph noise filter.
test('isLowValueEntity drops generic/short/numeric, keeps structured + real names', () => {
  assert.equal(isLowValueEntity('org', 'ai'), true); // < 3 chars
  assert.equal(isLowValueEntity('tech', 'data'), true); // stopword
  assert.equal(isLowValueEntity('org', '2024'), true); // pure numeric
  assert.equal(isLowValueEntity('org', 'openai'), false); // a real name survives
  assert.equal(isLowValueEntity('domain', 'ai'), false); // structured IOC types are never filtered
  assert.equal(isLowValueEntity('cve', 'x'), false);
});
