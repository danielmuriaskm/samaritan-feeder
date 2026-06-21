import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';

import {
  safeFetch,
  assertUrlAllowed,
  assertEgressAllowed,
  STREAM_URL_SCHEMES,
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
  SsrfError,
  BLOCKED_IPV4_RANGES,
} from './safeFetch.js';

// ---------------------------------------------------------------------------
// 1. Private / reserved IPv4 matcher
// ---------------------------------------------------------------------------

test('isBlockedIPv4 flags every private/reserved range', () => {
  const blocked = [
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1', // CGNAT low edge
    '100.127.255.255', // CGNAT high edge
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254', // cloud metadata
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255', // /12 high edge
    '192.168.0.1',
    '192.168.255.255',
    '224.0.0.1', // multicast
    '239.255.255.255',
    '240.0.0.1', // reserved
    '255.255.255.255', // broadcast
  ];
  for (const ip of blocked) {
    assert.ok(isBlockedIPv4(ip), `expected ${ip} to be blocked`);
  }
});

test('isBlockedIPv4 allows public addresses and range boundaries', () => {
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '9.255.255.255', // just below 10/8
    '11.0.0.0', // just above 10/8
    '100.63.255.255', // just below CGNAT 100.64/10
    '100.128.0.0', // just above CGNAT
    '126.255.255.255', // just below 127/8
    '128.0.0.1', // just above 127/8
    '169.253.255.255', // just below link-local
    '169.255.0.0', // just above link-local
    '172.15.255.255', // just below 172.16/12
    '172.32.0.0', // just above 172.16/12
    '192.167.255.255', // just below 192.168/16
    '192.169.0.0', // just above 192.168/16
    '223.255.255.255', // just below multicast 224/4
  ];
  for (const ip of allowed) {
    assert.equal(isBlockedIPv4(ip), null, `expected ${ip} to be allowed`);
  }
});

test('the blocked IPv4 table parsed every CIDR', () => {
  assert.ok(BLOCKED_IPV4_RANGES.length >= 10);
  for (const range of BLOCKED_IPV4_RANGES) {
    assert.ok(range.mask >= 0 && range.cidr.includes('/'));
  }
});

// ---------------------------------------------------------------------------
// 2. Private / reserved IPv6 matcher (incl. v4-mapped extraction)
// ---------------------------------------------------------------------------

test('isBlockedIPv6 flags reserved IPv6 and v4-mapped private', () => {
  const blocked = [
    '::1', // loopback
    '::', // unspecified
    'fc00::1', // unique-local
    'fd12:3456::1', // unique-local
    'fe80::1', // link-local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // v4-mapped loopback
    '::ffff:169.254.169.254', // v4-mapped metadata
    '::ffff:10.0.0.1', // v4-mapped RFC1918
    '64:ff9b::127.0.0.1', // NAT64 -> loopback
  ];
  for (const ip of blocked) {
    assert.ok(isBlockedIPv6(ip), `expected ${ip} to be blocked`);
  }
});

test('isBlockedIPv6 allows public v6 and v4-mapped public', () => {
  assert.equal(isBlockedIPv6('2001:4860:4860::8888'), null); // Google DNS
  assert.equal(isBlockedIPv6('2606:4700:4700::1111'), null); // Cloudflare DNS
  assert.equal(isBlockedIPv6('::ffff:8.8.8.8'), null); // v4-mapped public
});

test('isBlockedAddress dispatches on family and ignores non-IPs', () => {
  assert.ok(isBlockedAddress('127.0.0.1'));
  assert.ok(isBlockedAddress('::1'));
  assert.equal(isBlockedAddress('8.8.8.8'), null);
  assert.equal(isBlockedAddress('example.com'), null); // hostname, handled via DNS path
});

// ---------------------------------------------------------------------------
// 3. URL hygiene
// ---------------------------------------------------------------------------

test('assertUrlAllowed rejects bad schemes, creds, localhost, literal private IPs', () => {
  const bad = [
    'ftp://example.com/x',
    'file:///etc/passwd',
    'gopher://example.com',
    'data:text/plain,hi',
    'http://user:pass@example.com/', // embedded credentials
    'http://localhost/', // localhost
    'http://foo.localhost/', // *.localhost
    'http://127.0.0.1/', // loopback literal
    'http://169.254.169.254/latest/meta-data/', // metadata literal
    'http://[::1]:8080/', // IPv6 loopback literal
    'https://[fd00::1]/', // IPv6 ULA literal
    'http://10.0.0.5/', // RFC1918 literal
    'not a url',
  ];
  for (const url of bad) {
    assert.throws(() => assertUrlAllowed(url), SsrfError, `expected ${url} to be rejected`);
  }
});

test('assertUrlAllowed accepts ordinary public URLs', () => {
  for (const url of ['https://example.com/path?q=1', 'http://data.example.org:8080/feed']) {
    const allowed = assertUrlAllowed(url);
    assert.equal(allowed.url.protocol.startsWith('http'), true);
    assert.equal(allowed.literalIp, null);
  }
});

test('allowPrivate bypasses the IP/localhost rejection but not scheme/credentials', () => {
  // Internal escape hatch: localhost + private literals are allowed...
  assert.doesNotThrow(() => assertUrlAllowed('http://localhost:8081/v1/analyze', true));
  assert.doesNotThrow(() => assertUrlAllowed('http://127.0.0.1:1984/', true));
  // ...but scheme and credential hygiene still hold.
  assert.throws(() => assertUrlAllowed('file:///etc/passwd', true), SsrfError);
  assert.throws(() => assertUrlAllowed('http://user:pass@127.0.0.1/', true), SsrfError);
});

// ---------------------------------------------------------------------------
// 4. DNS rebinding — reject when the hostname resolves to a blocked address,
//    even though the URL itself looks innocuous. This is the core defense.
// ---------------------------------------------------------------------------

test('safeFetch rejects a host that resolves to the cloud-metadata IP', async () => {
  const lookupAll = async (): Promise<LookupAddress[]> => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    safeFetch('http://evil.example.com/', { lookupAll }),
    (err: unknown) => err instanceof SsrfError && /169\.254\.169\.254/.test((err as Error).message),
  );
});

test('safeFetch rejects when ANY resolved address is private (rebinding via mixed records)', async () => {
  // A rebinder returns one public and one private A record; we must refuse both.
  const lookupAll = async (): Promise<LookupAddress[]> => [
    { address: '93.184.216.34', family: 4 }, // public
    { address: '10.1.2.3', family: 4 }, // private smuggled in
  ];
  await assert.rejects(
    safeFetch('http://rebind.example.com/', { lookupAll }),
    (err: unknown) => err instanceof SsrfError && /10\.1\.2\.3/.test((err as Error).message),
  );
});

test('safeFetch rejects a host resolving only to an IPv6 ULA', async () => {
  const lookupAll = async (): Promise<LookupAddress[]> => [{ address: 'fd00::1', family: 6 }];
  await assert.rejects(safeFetch('http://v6rebind.example.com/', { lookupAll }), SsrfError);
});

// ---------------------------------------------------------------------------
// 4b. Egress guard for ffmpeg / yt-dlp (assertEgressAllowed)
// ---------------------------------------------------------------------------

test('assertEgressAllowed blocks ffmpeg local-file/IPC schemes', async () => {
  for (const url of ['file:///etc/passwd', 'pipe:1', 'concat:/etc/passwd|x', 'data:text/plain,hi', 'gopher://x/']) {
    await assert.rejects(
      assertEgressAllowed(url, { allowedSchemes: STREAM_URL_SCHEMES, allowCredentials: true }),
      SsrfError,
      `expected ${url} to be blocked`,
    );
  }
});

test('assertEgressAllowed blocks literal private hosts across stream schemes', async () => {
  await assert.rejects(
    assertEgressAllowed('rtsp://10.0.0.5:554/stream', { allowedSchemes: STREAM_URL_SCHEMES, allowCredentials: true }),
    SsrfError,
  );
  await assert.rejects(
    assertEgressAllowed('http://169.254.169.254/', { allowedSchemes: STREAM_URL_SCHEMES }),
    SsrfError,
  );
});

test('assertEgressAllowed allows a public RTSP literal, with embedded creds when permitted', async () => {
  const ok = await assertEgressAllowed('rtsp://admin:secret@203.0.113.9:554/stream', {
    allowedSchemes: STREAM_URL_SCHEMES,
    allowCredentials: true,
  });
  assert.equal(ok.host, '203.0.113.9');
  // 203.0.113.0/24 is TEST-NET-3 — public-routable from the matcher's view (not in the private table).
  assert.equal(isBlockedAddress('203.0.113.9'), null);
});

test('assertEgressAllowed enforces the credential policy', async () => {
  await assert.rejects(
    assertEgressAllowed('http://user:pass@8.8.8.8/', { allowedSchemes: STREAM_URL_SCHEMES, allowCredentials: false }),
    SsrfError,
  );
});

test('assertEgressAllowed blocks a stream host that RESOLVES to a private address', async () => {
  const lookupAll = async () => [{ address: '192.168.1.10', family: 4 }];
  await assert.rejects(
    assertEgressAllowed('rtsp://cam.example.com/stream', {
      allowedSchemes: STREAM_URL_SCHEMES,
      allowCredentials: true,
      lookupAll,
    }),
    (err: unknown) => err instanceof SsrfError && /192\.168\.1\.10/.test((err as Error).message),
  );
});

test('assertEgressAllowed allowPrivate opts a LAN camera back in', async () => {
  await assert.doesNotReject(
    assertEgressAllowed('rtsp://10.0.0.5:554/stream', {
      allowedSchemes: STREAM_URL_SCHEMES,
      allowCredentials: true,
      allowPrivate: true,
    }),
  );
});

// ---------------------------------------------------------------------------
// 5. Integration against a local server (proves happy path, Response shape,
//    single-resolution pinning, and redirect following).
// ---------------------------------------------------------------------------

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('safeFetch returns a usable Response and resolves DNS exactly once (pinning)', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello world');
  });
  try {
    const port = new URL(server.url).port;
    let lookups = 0;
    // A hostname (not a literal) so the DNS path runs; map it to loopback. The
    // pinned address from this single lookup is what we connect to — connect()
    // must NOT resolve again.
    const lookupAll = async (host: string): Promise<LookupAddress[]> => {
      assert.equal(host, 'local.test');
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const res = await safeFetch(`http://local.test:${port}/`, { allowPrivate: true, lookupAll });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'hello world');
    assert.equal(lookups, 1, 'expected exactly one DNS resolution (pinned, no re-resolve)');
  } finally {
    await server.close();
  }
});

test('safeFetch follows redirects, re-validating each hop', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('arrived');
    }
  });
  try {
    const res = await safeFetch(`${server.url}/start`, { allowPrivate: true });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'arrived');
  } finally {
    await server.close();
  }
});

test('safeFetch HEAD yields a null-body Response with headers', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'x-probe': 'ok' });
    res.end();
  });
  try {
    const res = await safeFetch(server.url, { method: 'HEAD', allowPrivate: true });
    assert.equal(res.ok, true);
    assert.equal(res.headers.get('x-probe'), 'ok');
  } finally {
    await server.close();
  }
});

test('safeFetch enforces maxBodyBytes', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(64 * 1024, 0x41));
  });
  try {
    await assert.rejects(
      safeFetch(server.url, { allowPrivate: true, maxBodyBytes: 1024 }),
      (err: unknown) => err instanceof SsrfError && /exceeded/.test((err as Error).message),
    );
  } finally {
    await server.close();
  }
});
