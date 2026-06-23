/**
 * anonInfra — anonymizing-infrastructure membership lookups (Tor exit nodes and
 * open proxies).
 *
 * Clean-room port of the *idea* behind SpiderFoot's sfp_torexits.py and
 * sfp_multiproxy.py (smicallef/spiderfoot, MIT). No code copied — this is a
 * fresh TypeScript reimplementation of the concept: maintain TTL-refreshed
 * in-memory sets of IPs that belong to anonymizing infrastructure, and expose a
 * membership test that callers use to TAG (not score) an IP as context.
 *
 * Sources:
 *  - Tor exits via the Tor Project's onionoo details API, filtered to relays
 *    carrying the Exit flag. This is the live, authoritative list and carries the
 *    value of this module.
 *  - Open proxies via a multiproxy-style public list. The historical
 *    multiproxy.org feed is effectively dead in 2026, so this half is best-effort:
 *    it degrades to an empty/stale set and never throws.
 *
 * All network access goes through safeFetch (SSRF-hardened). Every refresh path
 * degrades rather than throwing: on failure we keep the last good set (or an
 * empty one) so a lookup always resolves to a plain boolean pair.
 */

import { safeFetch } from '../util/safeFetch.js';

// Refresh windows. Tor exits churn fast, so refresh hourly; the proxy list (when
// it exists at all) is far more static, so refresh daily.
const TOR_TTL_MS = 60 * 60 * 1000; // ~1h
const PROXY_TTL_MS = 24 * 60 * 60 * 1000; // ~24h

const TOR_EXITS_URL =
  'https://onionoo.torproject.org/details?type=relay&flag=Exit&fields=or_addresses';

// Multiproxy-style open-proxy feed. The canonical multiproxy.org endpoint is
// largely dead in 2026; this is kept as a best-effort source and is allowed to
// fail silently (the Tor half carries the module).
const OPEN_PROXY_URL = 'https://multiproxy.org/txt_all/proxy.txt';

interface RefreshState {
  /** Last successfully-built membership set. Survives a failed refresh. */
  set: Set<string>;
  /** Epoch ms of the last *successful* refresh, or 0 if never refreshed. */
  lastRefresh: number;
  /** In-flight refresh, so concurrent callers share a single fetch. */
  inFlight: Promise<void> | null;
}

const torState: RefreshState = { set: new Set(), lastRefresh: 0, inFlight: null };
const proxyState: RefreshState = { set: new Set(), lastRefresh: 0, inFlight: null };

/** Normalize an IP token: strip a `[v6]`/`v4:port` wrapper and lowercase it. */
function normalizeIp(raw: string): string | null {
  let s = raw.trim();
  if (s === '') return null;

  // onionoo or_addresses entries look like "1.2.3.4:9001" or "[2001:db8::1]:9001".
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end !== -1) return s.slice(1, end).toLowerCase();
    return s.toLowerCase();
  }

  // IPv4 with an optional :port — split only on the LAST colon so a bare IPv6
  // literal (multiple colons, no brackets) is left intact.
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.indexOf(':') === lastColon) {
    // exactly one colon => host:port
    s = s.slice(0, lastColon);
  }
  return s.toLowerCase();
}

/**
 * Fetch the Tor exit list from onionoo and build a fresh IP set. Returns the new
 * set, or null on any failure (caller keeps the previous set).
 */
async function fetchTorExits(): Promise<Set<string> | null> {
  try {
    const res = await safeFetch(TOR_EXITS_URL, { timeoutMs: 20000 });
    if (!res.ok) return null;
    const data = (await res.json()) as { relays?: Array<{ or_addresses?: string[] }> };
    const relays = Array.isArray(data.relays) ? data.relays : [];
    const next = new Set<string>();
    for (const relay of relays) {
      const addrs = Array.isArray(relay.or_addresses) ? relay.or_addresses : [];
      for (const addr of addrs) {
        const ip = normalizeIp(String(addr));
        if (ip) next.add(ip);
      }
    }
    return next;
  } catch {
    return null;
  }
}

/**
 * Fetch the open-proxy list and build a fresh IP set. Returns the new set, or
 * null on any failure. The body is a newline-delimited `ip:port` list; we keep
 * only the IP. Best-effort — a dead endpoint is expected and tolerated.
 */
async function fetchOpenProxies(): Promise<Set<string> | null> {
  try {
    const res = await safeFetch(OPEN_PROXY_URL, { timeoutMs: 20000 });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    const next = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const ip = normalizeIp(line);
      if (ip) next.add(ip);
    }
    // A non-empty body that yielded nothing usable is treated as a soft failure
    // so we keep any prior good set rather than clobbering it with empties.
    return next.size > 0 ? next : null;
  } catch {
    return null;
  }
}

/**
 * Refresh a single state object if its TTL has expired. Guards against concurrent
 * refreshes with an in-flight promise, and never throws — on failure the previous
 * set is retained and lastRefresh is left unchanged so a later call retries.
 */
async function refreshIfStale(
  state: RefreshState,
  ttlMs: number,
  fetcher: () => Promise<Set<string> | null>,
): Promise<void> {
  const now = Date.now();
  if (now - state.lastRefresh < ttlMs && state.lastRefresh !== 0) return;
  if (state.inFlight) return state.inFlight;

  state.inFlight = (async () => {
    try {
      const next = await fetcher();
      if (next) {
        state.set = next;
        state.lastRefresh = Date.now();
      } else if (state.lastRefresh === 0) {
        // First-ever load failed: mark the attempt so we back off for one TTL
        // window instead of hammering a dead endpoint on every lookup.
        state.lastRefresh = Date.now();
      }
    } catch {
      // Defensive: fetcher already swallows, but never let a refresh throw.
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

/**
 * Returns whether an IP is a known Tor exit node and/or open proxy. Lazily
 * (re)loads the backing sets within their TTL windows. Always resolves — on any
 * fetch failure it returns membership against the last good (or empty) set and
 * never throws.
 */
export async function isAnonInfra(ip: string): Promise<{ tor: boolean; proxy: boolean }> {
  const key = normalizeIp(ip);
  if (!key) return { tor: false, proxy: false };

  try {
    await Promise.all([
      refreshIfStale(torState, TOR_TTL_MS, fetchTorExits),
      refreshIfStale(proxyState, PROXY_TTL_MS, fetchOpenProxies),
    ]);
  } catch {
    // Refreshes are individually guarded; this is belt-and-braces.
  }

  return {
    tor: torState.set.has(key),
    proxy: proxyState.set.has(key),
  };
}
