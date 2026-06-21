/**
 * safeFetch — an SSRF-hardened replacement for the global `fetch`, for fetching
 * attacker-influenceable URLs (crawled hrefs, source-config stream URLs, OSINT
 * targets).
 *
 * Threat model & defenses
 * -----------------------
 * 1. URL hygiene — reject non-http(s) schemes (no file:, gopher:, ftp:, data:),
 *    reject embedded credentials (`http://user:pass@host`), reject `localhost`
 *    and literal private/reserved IP hosts.
 * 2. DNS rebinding — resolve A *and* AAAA for the hostname and reject if ANY
 *    returned address is private/reserved. A name that resolves to even one
 *    blocked address is refused outright (a rebinder that returns a public and a
 *    private record can't sneak the private one past us).
 * 3. TOCTOU close — the address we validated is the address we connect to. We
 *    pin the chosen address through a custom `lookup` AND fix `family` to the
 *    same family, so the OS resolver cannot be invoked a second time at connect
 *    time and reconnect us to a freshly-rebound private address.
 * 4. Redirects — every hop is re-parsed and re-validated through the same
 *    pipeline; `Authorization`/`Cookie` are stripped on cross-origin redirects.
 * 5. IPv4-first by default — several government data APIs (EIA, NASA FIRMS, FRED)
 *    publish broken AAAA records that hang with ETIMEDOUT; preferring IPv4 is a
 *    reliability fix as well as keeping the pinned family deterministic.
 *
 * Implementation is a clean-room reimplementation from the spec above, using
 * only Node built-ins (node:dns, node:net, node:http(s), node:zlib). MIT.
 */

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

// ---------------------------------------------------------------------------
// IPv4 private / reserved range table
// ---------------------------------------------------------------------------

interface ParsedCidr4 {
  /** Network base, masked, as an unsigned 32-bit int. */
  base: number;
  /** Netmask as an unsigned 32-bit int. */
  mask: number;
  label: string;
  cidr: string;
}

/** Convert a dotted-quad string to an unsigned 32-bit int, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value >>> 0;
}

function parseCidr4(cidr: string, label: string): ParsedCidr4 {
  const [addr, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const base = ipv4ToInt(addr);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`bad CIDR in table: ${cidr}`);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, label, cidr };
}

/**
 * IPv4 ranges that must never be fetched server-side. Exported so the table is
 * auditable and unit-testable.
 */
export const BLOCKED_IPV4_RANGES: ReadonlyArray<ParsedCidr4> = [
  parseCidr4('0.0.0.0/8', 'current network ("this host")'),
  parseCidr4('10.0.0.0/8', 'private (RFC1918)'),
  parseCidr4('100.64.0.0/10', 'carrier-grade NAT (RFC6598)'),
  parseCidr4('127.0.0.0/8', 'loopback'),
  parseCidr4('169.254.0.0/16', 'link-local / cloud metadata (169.254.169.254)'),
  parseCidr4('172.16.0.0/12', 'private (RFC1918)'),
  parseCidr4('192.0.0.0/24', 'IETF protocol assignments'),
  parseCidr4('192.0.2.0/24', 'documentation (TEST-NET-1)'),
  parseCidr4('192.168.0.0/16', 'private (RFC1918)'),
  parseCidr4('198.18.0.0/15', 'benchmarking'),
  parseCidr4('224.0.0.0/4', 'multicast'),
  parseCidr4('240.0.0.0/4', 'reserved / future use (incl. 255.255.255.255)'),
];

/** Returns a human-readable reason if the IPv4 is private/reserved, else null. */
export function isBlockedIPv4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return 'malformed IPv4';
  for (const range of BLOCKED_IPV4_RANGES) {
    if (((value & range.mask) >>> 0) === range.base) {
      return `${range.cidr} — ${range.label}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPv6 checks
// ---------------------------------------------------------------------------

function parseHextet(h: string): number {
  if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return NaN;
  return parseInt(h, 16);
}

/**
 * Expand an IPv6 address (incl. `::` compression and trailing dotted-quad
 * IPv4-mapped form) to its 16 bytes, or null if it doesn't parse.
 */
function ipv6ToBytes(input: string): number[] | null {
  let addr = input;

  // Drop a zone id, e.g. fe80::1%eth0.
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  // Rewrite a trailing embedded IPv4 (::ffff:127.0.0.1) into two hextets.
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const h1 = ((v4 >>> 16) & 0xffff).toString(16);
    const h2 = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${h1}:${h2}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const hasGap = halves.length === 2;
  const tail = hasGap ? (halves[1] ? halves[1].split(':') : []) : [];

  let hextets: number[];
  if (!hasGap) {
    if (head.length !== 8) return null;
    hextets = head.map(parseHextet);
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    hextets = [...head.map(parseHextet), ...new Array(missing).fill(0), ...tail.map(parseHextet)];
  }

  if (hextets.length !== 8 || hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) {
    return null;
  }

  const bytes: number[] = [];
  for (const h of hextets) bytes.push((h >> 8) & 0xff, h & 0xff);
  return bytes;
}

/** Returns a reason if the IPv6 is private/reserved, else null. */
export function isBlockedIPv6(ip: string): string | null {
  const b = ipv6ToBytes(ip);
  if (!b) return 'malformed IPv6';

  const allZero = b.every((x) => x === 0);
  if (allZero) return 'unspecified (::)';

  // ::1 loopback
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return 'IPv6 loopback (::1)';

  // ::ffff:a.b.c.d (v4-mapped) and ::a.b.c.d (deprecated v4-compatible):
  // the high 96 bits are zero (mapped also has 0xffff at bytes 10-11). Extract
  // the embedded IPv4 and apply the IPv4 table — a mapped public address is fine.
  const high80Zero = b.slice(0, 10).every((x) => x === 0);
  if (high80Zero) {
    const mapped = b[10] === 0xff && b[11] === 0xff;
    const compat = b[10] === 0x00 && b[11] === 0x00;
    if (mapped || compat) {
      const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
      const reason = isBlockedIPv4(v4);
      return reason ? `${mapped ? 'IPv4-mapped' : 'IPv4-compat'} ${v4} — ${reason}` : null;
    }
  }

  // 64:ff9b::/96 NAT64 — well-known prefix that embeds an IPv4 in the low 32 bits.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    const reason = isBlockedIPv4(v4);
    return reason ? `NAT64 ${v4} — ${reason}` : null;
  }

  if ((b[0] & 0xfe) === 0xfc) return 'IPv6 unique-local (fc00::/7)';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'IPv6 link-local (fe80::/10)';
  if (b[0] === 0xff) return 'IPv6 multicast (ff00::/8)';

  return null;
}

/**
 * Main matcher: given an IP *literal* (v4 or v6), return a reason string if it
 * is private/reserved/loopback/etc., or null if it is a routable public address.
 * Non-IP input returns null (hostnames are handled via the DNS path, not here).
 */
export function isBlockedAddress(ip: string): string | null {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIPv4(ip);
  if (kind === 6) return isBlockedIPv6(ip);
  return null;
}

// ---------------------------------------------------------------------------
// URL hygiene
// ---------------------------------------------------------------------------

interface AllowedUrl {
  url: URL;
  /** Hostname with any IPv6 brackets stripped. */
  host: string;
  /** Non-null if the host is an IP literal. */
  literalIp: string | null;
  /** net.isIP() family of the literal (4 or 6), 0 for hostnames. */
  literalFamily: number;
}

interface UrlPolicy {
  /** Permitted URL schemes incl. trailing colon, e.g. ['http:', 'https:']. */
  allowedSchemes: readonly string[];
  /** Whether `user:pass@` is tolerated (RTSP cameras commonly embed creds). */
  allowCredentials: boolean;
  /** Skip the localhost / private-IP rejections (internal-origin escape hatch). */
  allowPrivate: boolean;
}

/**
 * Parse + validate a URL's static properties against a policy. Throws SsrfError
 * on any scheme, credential, localhost, or literal-private-IP violation. Does
 * NOT touch DNS.
 */
function parseAndValidateUrl(raw: string | URL, policy: UrlPolicy): AllowedUrl {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new SsrfError(`invalid URL: ${String(raw)}`);
  }

  if (!policy.allowedSchemes.includes(url.protocol)) {
    throw new SsrfError(`blocked scheme: ${url.protocol}`);
  }
  if (!policy.allowCredentials && (url.username !== '' || url.password !== '')) {
    throw new SsrfError('blocked URL with embedded credentials');
  }

  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 literal
  if (host === '') throw new SsrfError(`blocked URL with empty host: ${url.protocol}`);

  const lower = host.toLowerCase();
  if (!policy.allowPrivate && (lower === 'localhost' || lower.endsWith('.localhost'))) {
    throw new SsrfError(`blocked hostname: ${host}`);
  }

  const literalFamily = net.isIP(host);
  const literalIp = literalFamily !== 0 ? host : null;
  if (literalIp !== null && !policy.allowPrivate) {
    const reason = isBlockedAddress(literalIp);
    if (reason) throw new SsrfError(`blocked literal IP ${literalIp}: ${reason}`);
  }

  return { url, host, literalIp, literalFamily };
}

/**
 * Parse + validate an http(s) URL's static properties (strict: http(s) only, no
 * embedded credentials). Throws SsrfError. Does NOT touch DNS.
 */
export function assertUrlAllowed(raw: string | URL, allowPrivate = false): AllowedUrl {
  return parseAndValidateUrl(raw, {
    allowedSchemes: ['http:', 'https:'],
    allowCredentials: false,
    allowPrivate,
  });
}

// ---------------------------------------------------------------------------
// DNS resolution + address pinning
// ---------------------------------------------------------------------------

export type LookupAllFn = (host: string) => Promise<LookupAddress[]>;

/** Default resolver: getaddrinfo for every family (respects /etc/hosts). */
const defaultLookupAll: LookupAllFn = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(new SsrfError(`DNS lookup failed for ${host}: ${err.message}`));
      else resolve(addresses);
    });
  });

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolve the host (or accept the literal) and validate EVERY resolved address.
 * Returns the full address set; throws SsrfError if any address is blocked (this
 * is the DNS-rebinding defense — a name with even one private record is refused).
 */
async function resolveValidatedAddresses(
  allowed: AllowedUrl,
  allowPrivate: boolean,
  lookupAll: LookupAllFn,
): Promise<LookupAddress[]> {
  if (allowed.literalIp !== null) {
    return [{ address: allowed.literalIp, family: allowed.literalFamily }];
  }
  const addresses = await lookupAll(allowed.host);
  if (addresses.length === 0) {
    throw new SsrfError(`DNS returned no addresses for ${allowed.host}`);
  }
  if (!allowPrivate) {
    for (const a of addresses) {
      const reason = isBlockedAddress(a.address);
      if (reason) {
        throw new SsrfError(`blocked: ${allowed.host} resolves to ${a.address} (${reason})`);
      }
    }
  }
  return addresses;
}

/**
 * Resolve + validate, then choose a single address to pin per the family
 * preference (IPv4-first by default).
 */
async function resolveAndPin(
  allowed: AllowedUrl,
  familyPref: 0 | 4 | 6,
  allowPrivate: boolean,
  lookupAll: LookupAllFn,
): Promise<PinnedAddress> {
  const addresses = await resolveValidatedAddresses(allowed, allowPrivate, lookupAll);

  const byFamily = (fam: number) => addresses.find((a) => a.family === fam);
  let chosen: LookupAddress | undefined;
  if (familyPref === 6) chosen = byFamily(6) ?? byFamily(4);
  else if (familyPref === 4) chosen = byFamily(4) ?? byFamily(6);
  else chosen = addresses[0];
  chosen ??= addresses[0];

  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * A Node `lookup` that always returns the single pre-validated, pinned address.
 * Because connect() uses this instead of getaddrinfo, no second resolution can
 * occur — the validated address is the connected address (closes the TOCTOU).
 */
function pinnedLookup(address: string, family: 4 | 6): http.RequestOptions['lookup'] {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    let cb = callback as (err: Error | null, address?: unknown, family?: number) => void;
    let wantAll = false;
    if (typeof options === 'function') {
      cb = options as typeof cb;
    } else if (options && typeof options === 'object') {
      wantAll = (options as { all?: boolean }).all === true;
    }
    if (wantAll) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as http.RequestOptions['lookup'];
}

// ---------------------------------------------------------------------------
// Egress guard for non-fetch consumers (ffmpeg / yt-dlp)
// ---------------------------------------------------------------------------

/**
 * URL schemes a media tool (ffmpeg/yt-dlp) may be pointed at. Deliberately
 * EXCLUDES ffmpeg's local-file / IPC protocols (file:, pipe:, concat:, subfile:,
 * data:, gopher:, …) which would otherwise turn a "stream URL" into a
 * local-file-read or command primitive.
 */
export const STREAM_URL_SCHEMES = ['rtsp:', 'rtsps:', 'rtmp:', 'rtmps:', 'http:', 'https:'] as const;

export interface EgressCheckOptions {
  /** Internal-origin escape hatch (e.g. a LAN camera). Default false. */
  allowPrivate?: boolean;
  /** Permitted schemes. Default http(s) only. */
  allowedSchemes?: readonly string[];
  /** Tolerate `user:pass@` (RTSP cameras embed creds). Default false. */
  allowCredentials?: boolean;
  /** Test seam: override DNS resolution. */
  lookupAll?: LookupAllFn;
}

/**
 * Validate that a URL is safe to hand to an external fetcher we CANNOT pin
 * (ffmpeg, yt-dlp): the scheme is on the allowlist and the host (literal, or
 * every DNS-resolved address) is publicly routable. Makes no HTTP request.
 *
 * Note: unlike {@link safeFetch}, the downstream tool re-resolves DNS itself, so
 * a sub-second rebinding window remains. This blocks the realistic cases
 * (literal-private hosts, stably-private hosts, local-file schemes); fully
 * closing rebinding for an external process needs a network sandbox.
 */
export async function assertEgressAllowed(
  raw: string | URL,
  options: EgressCheckOptions = {},
): Promise<{ url: URL; host: string; addresses: LookupAddress[] }> {
  const {
    allowPrivate = false,
    allowedSchemes = ['http:', 'https:'],
    allowCredentials = false,
    lookupAll = defaultLookupAll,
  } = options;

  const allowed = parseAndValidateUrl(raw, { allowedSchemes, allowCredentials, allowPrivate });
  const addresses = await resolveValidatedAddresses(allowed, allowPrivate, lookupAll);
  return { url: allowed.url, host: allowed.host, addresses };
}

// ---------------------------------------------------------------------------
// HTTP request (single hop) + response handling
// ---------------------------------------------------------------------------

interface RawResponse {
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  decompressed: boolean;
}

function decompress(buf: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  if (enc.includes('gzip')) return zlib.gunzipSync(buf);
  if (enc.includes('deflate')) {
    try {
      return zlib.inflateSync(buf);
    } catch {
      return zlib.inflateRawSync(buf);
    }
  }
  return buf;
}

function performRequest(
  url: URL,
  pinned: PinnedAddress,
  method: string,
  headers: Record<string, string>,
  body: string | Buffer | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');

    // Local copy so a per-hop Content-Length never leaks into the next hop.
    const outHeaders: Record<string, string> = { ...headers };
    const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
    const bodyBuf = hasBody ? (typeof body === 'string' ? Buffer.from(body, 'utf8') : body!) : undefined;
    if (bodyBuf && !hasHeader(outHeaders, 'content-length')) {
      outHeaders['Content-Length'] = String(bodyBuf.byteLength);
    }

    const reqOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname || '/'}${url.search}`,
      method,
      headers: outHeaders,
      family: pinned.family,
      lookup: pinnedLookup(pinned.address, pinned.family),
      // One-shot socket (no keep-alive pooling) so a pinned connection is never
      // reused for a later, differently-resolved request.
      agent: false,
      signal,
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBodyBytes) {
          req.destroy(new SsrfError(`response body exceeded ${maxBodyBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] ?? '');
        let out: Buffer = raw;
        let decompressed = false;
        if (encoding && encoding.toLowerCase() !== 'identity' && raw.length > 0) {
          try {
            out = decompress(raw, encoding);
            decompressed = true;
          } catch {
            out = raw;
            decompressed = false;
          }
        }
        resolve({
          statusCode: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? '',
          headers: res.headers,
          body: out,
          decompressed,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new SsrfError(`request to ${url.host} timed out after ${timeoutMs}ms`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Buffer;
  /** Abort signal (e.g. AbortSignal.timeout(ms)). */
  signal?: AbortSignal;
  /** Per-hop timeout. Default 15000ms. */
  timeoutMs?: number;
  /** Max redirects to follow (each re-validated). Default 5. */
  maxRedirects?: number;
  /** Cap on response body bytes (compressed). Default 25 MiB. */
  maxBodyBytes?: number;
  /** Address family preference. Default 4 (IPv4-first). 0 = resolver order. */
  family?: 0 | 4 | 6;
  /**
   * Escape hatch for KNOWN-INTERNAL origins (e.g. the cv-sidecar / go2rtc
   * localhost endpoints). Skips the private/reserved-IP and localhost rejections.
   * Scheme + credential checks still apply. Never set this for any URL derived
   * from crawled content or source config.
   */
  allowPrivate?: boolean;
  /** Test seam: override DNS resolution. Defaults to getaddrinfo. */
  lookupAll?: LookupAllFn;
}

const DEFAULT_MAX_BODY = 25 * 1024 * 1024;

function normalizeHeaders(input: SafeFetchOptions['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key] = value;
    });
  } else {
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
  }
  return out;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) delete headers[key];
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

function buildResponse(raw: RawResponse, method: string): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, String(value));
  }
  // We already decompressed the body; drop now-misleading framing headers.
  if (raw.decompressed) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const nullBody = method === 'HEAD' || raw.statusCode === 204 || raw.statusCode === 304;
  // Copy into a plain ArrayBuffer-backed view so the body is a well-typed BodyInit.
  const bodyInit = nullBody ? null : new Uint8Array(raw.body);
  return new Response(bodyInit, {
    status: raw.statusCode,
    statusText: raw.statusMessage,
    headers,
  });
}

/**
 * SSRF-safe fetch. Returns a standard `Response`, so it is a drop-in for the
 * subset of the Fetch API used by the adapters (`ok`, `status`, `statusText`,
 * `headers.get`, `text()`, `json()`, `arrayBuffer()`).
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    allowPrivate = false,
    family = 4,
    timeoutMs = 15000,
    maxRedirects = 5,
    maxBodyBytes = DEFAULT_MAX_BODY,
    signal,
    lookupAll = defaultLookupAll,
  } = options;

  let currentUrl = typeof input === 'string' ? input : input.toString();
  let method = (options.method ?? 'GET').toUpperCase();
  let headers = normalizeHeaders(options.headers);
  let body = options.body;
  let redirectsLeft = maxRedirects;

  // Request plain bytes by default — keeps decompression a rarely-needed safety
  // net rather than the common path.
  if (!hasHeader(headers, 'accept-encoding')) headers['accept-encoding'] = 'identity';

  for (;;) {
    const allowed = assertUrlAllowed(currentUrl, allowPrivate);
    const pinned = await resolveAndPin(allowed, family, allowPrivate, lookupAll);
    const raw = await performRequest(allowed.url, pinned, method, headers, body, signal, timeoutMs, maxBodyBytes);

    const location = raw.headers.location;
    const isRedirect = raw.statusCode >= 300 && raw.statusCode < 400 && typeof location === 'string';

    if (isRedirect && redirectsLeft > 0) {
      redirectsLeft--;
      const nextUrl = new URL(location, allowed.url);

      // 303 (and 301/302 on an unsafe method) downgrade to GET and drop the body.
      const downgrade =
        raw.statusCode === 303 ||
        ((raw.statusCode === 301 || raw.statusCode === 302) && method !== 'GET' && method !== 'HEAD');
      if (downgrade) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
        deleteHeader(headers, 'content-type');
        deleteHeader(headers, 'content-length');
      }

      // Never leak credentials across an origin boundary on redirect.
      if (nextUrl.origin !== allowed.url.origin) {
        deleteHeader(headers, 'authorization');
        deleteHeader(headers, 'cookie');
      }

      currentUrl = nextUrl.toString();
      continue;
    }

    return buildResponse(raw, method);
  }
}

export default safeFetch;
