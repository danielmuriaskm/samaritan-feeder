/**
 * Live ADS-B aircraft positions from adsb.lol — a FREE, no-key community feed.
 *
 * This is on-demand "radar" data (current positions for the visible map view),
 * NOT ingested events: there is no adapter, no SourceKind, no DB write. The map
 * asks for a bbox, we query adsb.lol around the bbox center within an appropriate
 * radius, normalize, and return. A short in-memory cache keyed by the rounded
 * query coalesces rapid map pans so we never hammer the free endpoint.
 *
 * adsb.lol API: GET https://api.adsb.lol/v2/lat/<lat>/lon/<lon>/dist/<nm>
 *   -> { ac: [ { hex, flight, lat, lon, alt_baro, gs, track, t, ... }, ... ] }
 * Distance is in nautical miles, capped by the service at 250nm.
 */

import { safeFetch } from '../util/safeFetch.js';

export interface Aircraft {
  id: string;
  lat: number;
  lon: number;
  /** Track / true heading in degrees (0 = north), or null if unknown. */
  heading: number | null;
  /** Barometric altitude in feet, or null. ("ground" is normalized to 0.) */
  alt: number | null;
  /** Ground speed in knots, or null. */
  speed: number | null;
  /** Callsign / flight number (trimmed), or null. */
  callsign: string | null;
  /** ICAO type code (e.g. "A320"), or null. */
  type: string | null;
}

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

const ADSB_BASE = 'https://api.adsb.lol/v2';
/** adsb.lol caps the radius at 250nm; stay just under. */
const MAX_RADIUS_NM = 250;
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  at: number;
  data: Aircraft[];
}
const cache = new Map<string, CacheEntry>();

/** Earth radius in nautical miles (for a rough bbox -> radius conversion). */
const EARTH_RADIUS_NM = 3440.065;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lon points, in nautical miles. */
function haversineNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * adsb.lol is a circular query (center + radius), but the map gives us a
 * rectangle. Query a circle that covers the bbox: center on the bbox center, use
 * the distance to a corner as the radius (so the whole rectangle is inside the
 * circle), then filter the returned set back down to the rectangle.
 */
function bboxToQuery(bbox: Bbox): { lat: number; lon: number; nm: number } {
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  const lon = (bbox.minLon + bbox.maxLon) / 2;
  const cornerNm = haversineNm(lat, lon, bbox.maxLat, bbox.maxLon);
  // Pad a little so aircraft on the very edge aren't clipped by rounding.
  const nm = Math.min(MAX_RADIUS_NM, Math.max(1, Math.ceil(cornerNm * 1.05)));
  return { lat, lon, nm };
}

function inBbox(lat: number, lon: number, bbox: Bbox): boolean {
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Normalize one adsb.lol aircraft record. Returns null if it has no usable position. */
function normalize(ac: Record<string, unknown>): Aircraft | null {
  const lat = num(ac.lat);
  const lon = num(ac.lon);
  if (lat === null || lon === null) return null;

  // alt_baro may be the string "ground".
  let alt: number | null;
  if (ac.alt_baro === 'ground') alt = 0;
  else alt = num(ac.alt_baro) ?? num(ac.alt_geom);

  const flight = typeof ac.flight === 'string' ? ac.flight.trim() : '';
  const id =
    (typeof ac.hex === 'string' && ac.hex.trim()) || flight || `${lat.toFixed(4)},${lon.toFixed(4)}`;

  return {
    id,
    lat,
    lon,
    heading: num(ac.track) ?? num(ac.true_heading) ?? num(ac.nav_heading),
    alt,
    speed: num(ac.gs),
    callsign: flight || null,
    type: typeof ac.t === 'string' && ac.t.trim() ? ac.t.trim() : null,
  };
}

/**
 * Single-aircraft lookup by ICAO24 hex — backs the /radar/aircraft/:id detail
 * panel. Hits adsb.lol's /v2/icao/<hex> endpoint (key-free). Returns null when the
 * id isn't a hex or the aircraft isn't currently transmitting.
 */
export async function getAircraftById(icao: string): Promise<Aircraft | null> {
  const hex = icao.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  try {
    const res = await safeFetch(`${ADSB_BASE}/icao/${hex}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Samaritan-Feeder/0.1' },
      timeoutMs: 12_000,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ac?: unknown };
    const list = Array.isArray(body.ac) ? body.ac : [];
    for (const a of list) {
      const norm = normalize(a as Record<string, unknown>);
      if (norm) return norm;
    }
  } catch {
    // best-effort radar — fall through to null on network / parse failure.
  }
  return null;
}

/**
 * Fetch live aircraft whose current position falls inside the bbox.
 * Cached ~10s per (rounded) query to spare the free endpoint during map panning.
 */
export async function getAircraftInBbox(bbox: Bbox): Promise<Aircraft[]> {
  const { lat, lon, nm } = bboxToQuery(bbox);
  // Round the query so nearby pans hit the same cache key.
  const key = `${lat.toFixed(2)}:${lon.toFixed(2)}:${nm}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.data.filter((a) => inBbox(a.lat, a.lon, bbox));
  }

  const url = `${ADSB_BASE}/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`;
  let aircraft: Aircraft[] = [];
  try {
    const res = await safeFetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Samaritan-Feeder/0.1' },
      timeoutMs: 12_000,
    });
    if (res.ok) {
      const body = (await res.json()) as { ac?: unknown };
      const list = Array.isArray(body.ac) ? body.ac : [];
      aircraft = list
        .map((a) => normalize(a as Record<string, unknown>))
        .filter((a): a is Aircraft => a !== null);
    }
  } catch {
    // Network / SSRF / parse failure — radar is best-effort; fall through to [].
    aircraft = [];
  }

  cache.set(key, { at: now, data: aircraft });
  // Bound the cache so an attacker panning the map can't grow it without limit.
  if (cache.size > 256) {
    for (const k of cache.keys()) {
      if (cache.size <= 256) break;
      cache.delete(k);
    }
  }

  return aircraft.filter((a) => inBbox(a.lat, a.lon, bbox));
}
