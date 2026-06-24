import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLineFeed, parsePhishtankCsv } from './openphish.js';
import { parseZonehRss } from './zoneh.js';

// --- OpenPhish line feed -----------------------------------------------------
test('parseLineFeed keeps http(s) URLs, skips blanks/comments/non-http, extracts host', () => {
  const text = [
    'https://evil.example.com/login',
    '',
    '# a comment',
    'http://phish.test/x',
    'ftp://not-http/y',
    'notaurl',
  ].join('\n');
  const out = parseLineFeed(text, 'openphish');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.host), ['evil.example.com', 'phish.test']);
  assert.equal(out[0].feed, 'openphish');
  assert.equal(out[0].url, 'https://evil.example.com/login');
});

// --- PhishTank CSV -----------------------------------------------------------
test('parsePhishtankCsv finds the url column from the header row', () => {
  const csv = [
    'phish_id,url,phish_detail_url,submission_time',
    '123,https://a.example/login,http://detail,2026',
    '124,https://b.example/x,http://detail,2026',
    ',,,',
  ].join('\n');
  const out = parsePhishtankCsv(csv);
  assert.deepEqual(out.map((p) => p.url), ['https://a.example/login', 'https://b.example/x']);
  assert.equal(out[0].feed, 'phishtank');
});

test('parsePhishtankCsv falls back to column index 1 when there is no header', () => {
  const out = parsePhishtankCsv('999,https://c.example/p,http://detail,2026');
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://c.example/p');
});

// --- Zone-H RSS --------------------------------------------------------------
test('parseZonehRss takes the host from the TITLE, never the mirror <link>', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>defaced-site.example</title><link>https://www.zone-h.org/mirror/id/123</link></item>
  </channel></rss>`;
  const out = parseZonehRss(xml);
  assert.equal(out.length, 1);
  assert.equal(out[0].host, 'defaced-site.example'); // NOT zone-h.org
  assert.ok(out[0].link.includes('zone-h.org'));
});

test('parseZonehRss handles a single (non-array) item and an empty channel', () => {
  const single = `<rss><channel><item><title>http://x.example/path</title><link>l</link></item></channel></rss>`;
  const one = parseZonehRss(single);
  assert.equal(one.length, 1);
  assert.equal(one[0].host, 'x.example');
  assert.equal(parseZonehRss('<rss><channel></channel></rss>').length, 0);
});
