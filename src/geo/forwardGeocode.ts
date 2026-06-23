/**
 * forwardGeocode — advisory forward geocoding via OpenStreetMap Nominatim.
 *
 * Turns a free-text place name (typically from ./placeExtract.ts) into a single
 * lat/lon pair. This is purely advisory: it returns coordinates and nothing
 * else, and it must NEVER touch scoring or the DB. Callers decide whether to
 * attach the result to an event that has no location of its own.
 *
 * Clean-room port of the *idea* behind SpiderFoot's sfp_openstreetmap.py
 * (smicallef/spiderfoot, MIT): query Nominatim's /search endpoint for a place
 * string and read the first result's lat/lon. SpiderFoot's module is a thin
 * wrapper over that endpoint with a 1 req/s throttle; this is an independent
 * reimplementation of that behaviour (own throttle + cache, own parsing). No
 * code copied. MIT.
 *
 * Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * is mandatory for the public endpoint and shapes the design here:
 *   - A meaningful, identifying User-Agent is REQUIRED — we send one.
 *   - Absolute maximum of 1 request/second — we serialize calls through a
 *     module-level promise chain that spaces them >= 1s apart.
 *   - Cache results and don't re-query the same string — we keep a bounded
 *     in-memory cache, including negative caching of misses.
 *
 * Failure posture: every error path degrades to `undefined`. We never throw,
 * because a geocode is a nice-to-have enrichment, not a correctness invariant.
 */

import { safeFetch } from '../util/safeFetch.js';

export interface Coordinates {
  lat: number;
  lon: number;
}

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';

/**
 * Identifying User-Agent. Nominatim rejects/blocks generic agents; this names
 * the application and its purpose per their policy.
 */
const USER_AGENT = 'samaritan-feeder/0.1 (intelligence feeder)';

/** Hard floor between successive outbound requests (Nominatim: <= 1 req/s). */
const MIN_INTERVAL_MS = 1100;

/** Per-request timeout — generous, since requests are also queued behind each other. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Cap on the in-memory cache; oldest entry is evicted past this. */
const CACHE_CAP = 5000;

/**
 * Bounded, insertion-ordered cache of name -> coords. A `null` value is a
 * negative cache entry (a miss we've already paid for and won't re-query).
 * Map iteration order is insertion order, so the first key is the oldest.
 */
const cache = new Map<string, Coordinates | null>();

function cacheGet(key: string): Coordinates | null | undefined {
  if (!cache.has(key)) return undefined;
  // Refresh recency: delete + re-set moves the key to the newest position so a
  // frequently-hit entry survives eviction (approximate LRU).
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key: string, value: Coordinates | null): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Serialization tail. Every geocode request appends itself to this promise
 * chain, guaranteeing (a) only one request is in flight at a time and (b)
 * successive requests are spaced >= MIN_INTERVAL_MS apart. The chain never
 * rejects (each link swallows its own errors), so it can't get poisoned.
 */
let queueTail: Promise<void> = Promise.resolve();
/** Wall-clock time the last request was dispatched. */
let lastRequestAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Schedule `task` to run after the queue drains and the rate limit allows it.
 * Returns a promise that resolves with the task's result (or its thrown error
 * surfaced as a rejection to the *caller* only — the internal chain stays clean).
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const now = Date.now();
    const wait = lastRequestAt + MIN_INTERVAL_MS - now;
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
    return task();
  });
  // Keep the shared tail un-rejectable: swallow errors on the chain copy only.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Normalize a place name into a stable cache key. */
function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parse Nominatim's lat/lon strings into a validated Coordinates, or undefined. */
function parseResult(body: unknown): Coordinates | undefined {
  if (!Array.isArray(body) || body.length === 0) return undefined;
  const first = body[0] as { lat?: unknown; lon?: unknown };
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return undefined;
  }
  return { lat, lon };
}

/** Issue the actual Nominatim request. Returns coords, or undefined on any failure. */
async function queryNominatim(name: string): Promise<Coordinates | undefined> {
  const url = `${NOMINATIM_SEARCH}?format=json&limit=1&q=${encodeURIComponent(name)}`;
  try {
    const res = await safeFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    return parseResult(body);
  } catch {
    // Network error, timeout, SSRF rejection, bad JSON — all degrade to a miss.
    return undefined;
  }
}

/**
 * Resolve a free-text place name to `{ lat, lon }`, or `undefined` if it can't
 * be geocoded. Results (and misses) are cached, and outbound requests are
 * throttled to Nominatim's 1 req/s policy. Never throws.
 */
export async function geocodePlace(name: string): Promise<Coordinates | undefined> {
  if (typeof name !== 'string') return undefined;
  const key = normalizeKey(name);
  if (key.length === 0) return undefined;

  const cached = cacheGet(key);
  if (cached !== undefined) return cached ?? undefined;

  // Run the network call on the rate-limited queue.
  let coords: Coordinates | undefined;
  try {
    coords = await enqueue(() => queryNominatim(key));
  } catch {
    coords = undefined;
  }

  // Cache the outcome, including negative results, to avoid re-querying.
  cacheSet(key, coords ?? null);
  return coords;
}

export default geocodePlace;
