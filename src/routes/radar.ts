/**
 * Live "radar" router — on-demand current positions for the visible map view.
 *
 * Mounted twice from src/index.ts (see that file for the exact lines):
 *   - at `/radar`   -> GET /radar/aircraft, /radar/ships, /radar/aircraft/:id, /radar/ships/:id
 *   - at `/cameras` -> GET /cameras/markers, /cameras/count, /cameras/:id
 * and again under the `/api` prefix for the web console (and for samaritan-server,
 * which proxies /radar/* and /cameras/* to the feeder).
 *
 * RESPONSE CONTRACT: these endpoints are consumed by samaritan-server's web app
 * (apps/web Radar.tsx) via the feeder proxy, so the shapes below MUST match what
 * that SPA reads — `{ aircraft|ships|markers, count }` for the layers (NOT `total`),
 * `{ total, byCountry, byCategory }` for /cameras/count, and the `{ camera|aircraft|ship }`
 * detail envelopes for the side panels. Field names follow the web's row/detail
 * interfaces (e.g. `altitude` not `alt`, `updatedAt` not `at`).
 *
 * This data is queried live per request (ADS-B / AIS / camera stores filtered to
 * the bbox); it is NOT ingested as events. No adapters, no SourceKind, no writes.
 */

import { Hono } from 'hono';
import { getAircraftInBbox, getAircraftById, type Aircraft, type Bbox } from '../radar/adsb.js';
import { getShipsInBbox, getShipById, type Ship } from '../radar/ais.js';
import { getWebcamsInBounds } from '../geo/webcamLibrary.js';
import { getIpCamerasInBounds } from '../geo/ipCameraLibrary.js';
import {
  countCameras,
  cameraCountriesLive,
  cameraCategoriesLive,
  camerasByNames,
  type CameraKind,
} from '../geo/cameraStore.js';

const app = new Hono();

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

/** Parse `bbox=minLat,minLon,maxLat,maxLon` defensively; null on any problem. */
function parseBbox(raw: string | undefined): Bbox | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  let [minLat, minLon, maxLat, maxLon] = parts;
  // Tolerate swapped corners.
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  // Clamp to valid geographic ranges.
  minLat = Math.max(-90, Math.min(90, minLat));
  maxLat = Math.max(-90, Math.min(90, maxLat));
  minLon = Math.max(-180, Math.min(180, minLon));
  maxLon = Math.max(-180, Math.min(180, maxLon));
  return { minLat, minLon, maxLat, maxLon };
}

function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

// ---- Shape adapters → the apps/web Radar.tsx row contracts ---------------------
// adsb.ts uses `alt`/no-onGround; the SPA's AircraftRow wants `altitude`, `onGround`,
// `origin`, `updatedAt`. ais.ts uses `at`; ShipRow wants `updatedAt`.

interface AircraftRow {
  id: string;
  callsign: string | null;
  lat: number;
  lon: number;
  heading: number | null;
  speed: number | null;
  altitude: number | null;
  onGround: boolean | null;
  origin: string | null;
  updatedAt: number;
}

function toAircraftRow(a: Aircraft, now: number): AircraftRow {
  return {
    id: a.id,
    callsign: a.callsign,
    lat: a.lat,
    lon: a.lon,
    heading: a.heading,
    speed: a.speed,
    altitude: a.alt,
    // adsb.lol normalizes on-ground to alt 0; treat 0 as ground, unknown alt as null.
    onGround: a.alt === 0 ? true : a.alt === null ? null : false,
    origin: null,
    updatedAt: now,
  };
}

interface ShipRow {
  id: string;
  name: string | null;
  lat: number;
  lon: number;
  heading: number | null;
  speed: number | null;
  updatedAt: number;
}

function toShipRow(s: Ship, now: number): ShipRow {
  return {
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    heading: s.heading,
    speed: s.speed,
    updatedAt: now,
  };
}

// ---- Aircraft (ADS-B, adsb.lol, key-free) -------------------------------------

app.get('/aircraft', async (c) => {
  const bbox = parseBbox(c.req.query('bbox'));
  // 200 with an empty layer on a missing/bad bbox — a 4xx would make React Query
  // retry-storm one bad pan into multiple outbound adsb.lol hits.
  if (!bbox) return c.json({ aircraft: [], count: 0 });
  const limit = parseLimit(c.req.query('limit'));
  const now = Date.now();
  const all = await getAircraftInBbox(bbox);
  const aircraft = all.slice(0, limit).map((a) => toAircraftRow(a, now));
  return c.json({ aircraft, count: aircraft.length });
});

// /aircraft/:id — detail panel for one aircraft (icao24 hex). Base position +
// best-effort fields; enrichment (registration/photo/route) is null here.
app.get('/aircraft/:id', async (c) => {
  const id = c.req.param('id');
  const a = await getAircraftById(id);
  if (!a) {
    return c.json({ error: 'aircraft not found (may have ttl-expired since the click — re-pan the map to refresh)' }, 404);
  }
  const row = toAircraftRow(a, Date.now());
  return c.json({
    aircraft: {
      ...row,
      icao24: a.id,
      registration: null,
      type: a.type,
      icaoType: a.type,
      manufacturer: null,
      owner: null,
      airlineName: null,
      airlineIcao: null,
      airlineIata: null,
      callsignIata: null,
      registrationCountry: null,
      origin: null,
      destination: null,
      photoUrl: null,
      photoCredit: null,
      photoLink: null,
    },
  });
});

// ---- Ships (AIS, aisstream.io, gated by AISSTREAM_API_KEY) ---------------------

app.get('/ships', async (c) => {
  const bbox = parseBbox(c.req.query('bbox'));
  if (!bbox) return c.json({ ships: [], count: 0 });
  const limit = parseLimit(c.req.query('limit'));
  const now = Date.now();
  const ships = getShipsInBbox(bbox).slice(0, limit).map((s) => toShipRow(s, now));
  return c.json({ ships, count: ships.length });
});

// /ships/:id — detail panel for one ship (in-memory AIS snapshot, keyed by id).
app.get('/ships/:id', async (c) => {
  const id = c.req.param('id');
  const s = getShipById(id);
  if (!s) {
    return c.json({ error: 'ship not found (may have ttl-expired since the click)' }, 404);
  }
  const mmsi = String(s.id).replace(/^\D+/, '') || String(s.id);
  return c.json({ ship: { ...toShipRow(s, Date.now()), mmsi } });
});

// ---- Camera markers / count (public.cameras via cameraStore) -------------------

interface CameraMarker {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  country: string;
  region?: string;
  provider?: string;
  streamUrl?: string | null;
  infoUrl?: string | null;
  streamType?: string | null;
}

/** Merge the webcam + IP-camera libraries within the bbox into one marker list.
 * Two indexed GIST bbox queries (each capped at `limit`), run in parallel. */
async function cameraMarkersInBbox(bbox: Bbox, limit: number): Promise<CameraMarker[]> {
  const [webcams, ipcams] = await Promise.all([
    getWebcamsInBounds(bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon, limit),
    getIpCamerasInBounds(bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon, limit),
  ]);
  const out: CameraMarker[] = [];
  for (const w of webcams) {
    out.push({
      id: `webcam:${w.name}`,
      name: w.name,
      lat: w.lat,
      lon: w.lon,
      category: w.category ?? 'webcam',
      country: w.country,
      region: w.region,
      provider: w.provider,
      streamUrl: w.streamUrl,
      infoUrl: w.infoUrl,
      streamType: w.streamType,
    });
  }
  for (const ip of ipcams) {
    out.push({
      id: `ip:${ip.name}`,
      name: ip.name,
      lat: ip.lat,
      lon: ip.lon,
      category: ip.category ?? 'ip_camera',
      country: ip.country,
      region: ip.region,
      provider: ip.provider,
      streamUrl: ip.streamUrl,
      infoUrl: ip.infoUrl,
      streamType: ip.streamType,
    });
  }
  return out;
}

app.get('/markers', async (c) => {
  const bbox = parseBbox(c.req.query('bbox'));
  if (!bbox) return c.json({ markers: [], count: 0 });
  const limit = parseLimit(c.req.query('limit'));
  const all = await cameraMarkersInBbox(bbox, limit);
  const markers = all.slice(0, limit);
  return c.json({ markers, count: markers.length });
});

app.get('/count', async (c) => {
  // The SPA's diagnostic pill reads { total, byCountry, byCategory } from the
  // catalog-wide count (no bbox). byCountry/byCategory are live-only rollups.
  const [total, byCountry, byCategory] = await Promise.all([
    countCameras(),
    cameraCountriesLive(),
    cameraCategoriesLive(),
  ]);
  // `count` kept as an alias for any legacy caller that read the old scalar shape.
  return c.json({ total, count: total, byCountry, byCategory });
});

// /:id — single-camera detail for the marker side panel. Marker ids look like
// "webcam:<name>" / "ip:<name>" (see cameraMarkersInBbox); resolve back to the
// public.cameras row by name. Registered LAST so the static routes above win.
app.get('/:id', async (c) => {
  const raw = c.req.param('id');
  const m = /^(webcam|ip):([\s\S]+)$/.exec(raw);
  const kind: CameraKind = m && m[1] === 'ip' ? 'ip' : 'webcam';
  const name = m ? m[2]! : raw;
  const rows = await camerasByNames(kind, [name]);
  const cam = rows[0];
  if (!cam) return c.json({ error: 'not found' }, 404);
  return c.json({
    camera: {
      id: raw,
      name: cam.name,
      country: cam.country,
      region: cam.region,
      lat: cam.lat,
      lon: cam.lon,
      streamUrl: cam.streamUrl,
      streamType: cam.streamType,
      infoUrl: cam.infoUrl,
      provider: cam.provider,
      category: cam.category,
    },
  });
});

export default app;
