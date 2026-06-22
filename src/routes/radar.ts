/**
 * Live "radar" router — on-demand current positions for the visible map view.
 *
 * Mounted twice from src/index.ts (see that file for the exact lines):
 *   - at `/radar`   -> GET /radar/aircraft, GET /radar/ships
 *   - at `/cameras` -> GET /cameras/markers, GET /cameras/count
 * and again under the `/api` prefix for the web console (and for samaritan-server,
 * which proxies /radar/* and /cameras/* to the feeder).
 *
 * This data is queried live per request (ADS-B / AIS / camera stores filtered to
 * the bbox); it is NOT ingested as events. No adapters, no SourceKind, no writes.
 */

import { Hono } from 'hono';
import { getAircraftInBbox, type Bbox } from '../radar/adsb.js';
import { getShipsInBbox } from '../radar/ais.js';
import { getWebcamsInBounds } from '../geo/webcamLibrary.js';
import { getIpCamerasInBounds } from '../geo/ipCameraLibrary.js';
import { countCameras } from '../geo/cameraStore.js';

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

// ---- Aircraft (ADS-B, adsb.lol, key-free) -------------------------------------

app.get('/aircraft', async (c) => {
  const bbox = parseBbox(c.req.query('bbox'));
  if (!bbox) {
    return c.json({ error: 'Invalid bbox. Use bbox=minLat,minLon,maxLat,maxLon' }, 400);
  }
  const limit = parseLimit(c.req.query('limit'));
  const all = await getAircraftInBbox(bbox);
  return c.json({ aircraft: all.slice(0, limit), total: all.length });
});

// ---- Ships (AIS, aisstream.io, gated by AISSTREAM_API_KEY) ---------------------

app.get('/ships', async (c) => {
  const bbox = parseBbox(c.req.query('bbox'));
  if (!bbox) {
    return c.json({ error: 'Invalid bbox. Use bbox=minLat,minLon,maxLat,maxLon' }, 400);
  }
  const limit = parseLimit(c.req.query('limit'));
  const all = getShipsInBbox(bbox);
  return c.json({ ships: all.slice(0, limit), total: all.length });
});

// ---- Camera markers / count (from the existing static libraries) ---------------

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
  if (!bbox) {
    return c.json({ error: 'Invalid bbox. Use bbox=minLat,minLon,maxLat,maxLon' }, 400);
  }
  const limit = parseLimit(c.req.query('limit'));
  const all = await cameraMarkersInBbox(bbox, limit);
  return c.json({ markers: all.slice(0, limit), total: all.length });
});

app.get('/count', async (c) => {
  // bbox optional: with one, count in view; without, count everything. A single
  // indexed COUNT (markers = all cameras), not a full marker materialization.
  const bbox = parseBbox(c.req.query('bbox'));
  return c.json({ count: await countCameras(bbox ?? undefined) });
});

export default app;
