/**
 * Live AIS ship positions.
 *
 * The good free source, aisstream.io, is a WebSocket stream that requires an API
 * key. This module is GATED behind `config.AISSTREAM_API_KEY`: when the key is
 * unset, getShipsInBbox() returns [] (with a single one-time warn) so the radar
 * layer degrades gracefully instead of erroring.
 *
 * When a key IS present, we keep a single long-lived WebSocket open (Node's
 * built-in global `WebSocket`, stable since Node 21 — no extra dependency) and
 * maintain an in-memory snapshot of the most recent position per MMSI.
 * aisstream requires a bounding-box subscription; since the map view changes, we
 * subscribe to a world-ish box on connect and prune stale vessels.
 * getShipsInBbox() just filters the snapshot — it never blocks on the network —
 * so it stays fast and on-demand from the route's point of view.
 *
 * Like the ADS-B layer this is on-demand radar data, NOT ingested events: no
 * adapter, no SourceKind, no DB write.
 */

import { config } from '../config.js';
import type { Bbox } from './adsb.js';

export interface Ship {
  id: string;
  lat: number;
  lon: number;
  /** Course over ground / true heading in degrees, or null. */
  heading: number | null;
  /** Speed over ground in knots, or null. */
  speed: number | null;
  /** Vessel name (trimmed) or null. */
  name: string | null;
  /** AIS ship type code as a string, or null. */
  type: string | null;
}

interface TrackedShip extends Ship {
  /** Last update (ms epoch) — used to prune stale vessels. */
  at: number;
}

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
/** Drop vessels we haven't heard from in this long. */
const STALE_MS = 30 * 60 * 1000;
/** Cap the snapshot so a busy feed can't grow memory unbounded. */
const MAX_TRACKED = 50_000;

const snapshot = new Map<string, TrackedShip>();

let warnedNoKey = false;
let started = false;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Heading 511 and COG 360 are the AIS "not available" sentinels. */
function heading(cog: unknown, trueHeading: unknown): number | null {
  const c = num(cog);
  if (c !== null && c >= 0 && c < 360) return c;
  const h = num(trueHeading);
  if (h !== null && h >= 0 && h < 360) return h;
  return null;
}

function pruneStale(now: number): void {
  for (const [mmsi, s] of snapshot) {
    if (now - s.at > STALE_MS) snapshot.delete(mmsi);
  }
  if (snapshot.size > MAX_TRACKED) {
    // Evict oldest-first until back under the cap.
    const sorted = [...snapshot.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [mmsi] of sorted) {
      if (snapshot.size <= MAX_TRACKED) break;
      snapshot.delete(mmsi);
    }
  }
}

/**
 * aisstream delivers heterogeneous message types. PositionReport carries lat/lon;
 * ShipStaticData carries the name + ship type. We merge both into the per-MMSI
 * record keyed by the common MetaData.MMSI.
 */
function ingest(msg: Record<string, unknown>): void {
  const meta = msg.MetaData as Record<string, unknown> | undefined;
  const messageType = msg.MessageType;
  const message = msg.Message as Record<string, unknown> | undefined;
  if (!meta || !message) return;

  const mmsi = num(meta.MMSI);
  if (mmsi === null) return;
  const id = String(mmsi);
  const now = Date.now();
  const prev = snapshot.get(id);

  const metaName = typeof meta.ShipName === 'string' ? meta.ShipName.trim() : '';

  if (messageType === 'PositionReport') {
    const pr = message.PositionReport as Record<string, unknown> | undefined;
    if (!pr) return;
    const lat = num(pr.Latitude) ?? num(meta.latitude);
    const lon = num(pr.Longitude) ?? num(meta.longitude);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    snapshot.set(id, {
      id,
      lat,
      lon,
      heading: heading(pr.Cog, pr.TrueHeading),
      speed: num(pr.Sog),
      name: metaName || prev?.name || null,
      type: prev?.type ?? null,
      at: now,
    });
  } else if (messageType === 'ShipStaticData') {
    const sd = message.ShipStaticData as Record<string, unknown> | undefined;
    if (!sd) return;
    // Static data has no position; only enrich an existing track (or stash the name).
    if (!prev) {
      if (metaName) {
        snapshot.set(id, {
          id,
          lat: NaN,
          lon: NaN,
          heading: null,
          speed: null,
          name: metaName,
          type: sd.Type != null ? String(sd.Type) : null,
          at: now,
        });
      }
      return;
    }
    snapshot.set(id, {
      ...prev,
      name: metaName || (typeof sd.Name === 'string' ? sd.Name.trim() : prev.name) || prev.name,
      type: sd.Type != null ? String(sd.Type) : prev.type,
      at: now,
    });
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(apiKey: string): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(apiKey);
  }, 15_000);
  // Don't keep the event loop alive solely for the reconnect timer.
  reconnectTimer.unref?.();
}

function connect(apiKey: string): void {
  // Node 21+ exposes a WHATWG `WebSocket` global. Guard for older runtimes.
  if (typeof WebSocket === 'undefined') {
    if (!warnedNoKey) {
      console.warn('[radar/ais] global WebSocket unavailable (need Node >= 21); ship radar disabled.');
      warnedNoKey = true;
    }
    return;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(AISSTREAM_URL);
  } catch {
    scheduleReconnect(apiKey);
    return;
  }

  ws.addEventListener('open', () => {
    // Subscribe to the whole world; getShipsInBbox filters the snapshot per view.
    ws.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }),
    );
  });

  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      const msg = JSON.parse(text) as Record<string, unknown>;
      if (msg.error || msg.Error) {
        console.warn('[radar/ais] aisstream error:', msg.error ?? msg.Error);
        ws.close();
        return;
      }
      ingest(msg);
      // Opportunistic prune so we don't need a separate timer.
      if (snapshot.size > MAX_TRACKED || Math.random() < 0.001) pruneStale(Date.now());
    } catch {
      // ignore malformed frames
    }
  });

  ws.addEventListener('close', () => scheduleReconnect(apiKey));
  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    scheduleReconnect(apiKey);
  });
}

/** Lazily start the background AIS subscription the first time ships are requested. */
function ensureStarted(): boolean {
  const apiKey = config.AISSTREAM_API_KEY;
  if (!apiKey) {
    if (!warnedNoKey) {
      console.warn('[radar/ais] AISSTREAM_API_KEY unset — ship radar disabled (returning empty).');
      warnedNoKey = true;
    }
    return false;
  }
  if (!started) {
    started = true;
    connect(apiKey);
  }
  return true;
}

/**
 * Return the most recent known positions of ships inside the bbox. Never blocks
 * on the network: it reads the in-memory snapshot maintained by the background
 * WebSocket. Returns [] when no API key is configured.
 */
export function getShipsInBbox(bbox: Bbox): Ship[] {
  if (!ensureStarted()) return [];
  const out: Ship[] = [];
  for (const s of snapshot.values()) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    if (s.lat < bbox.minLat || s.lat > bbox.maxLat || s.lon < bbox.minLon || s.lon > bbox.maxLon) {
      continue;
    }
    out.push({ id: s.id, lat: s.lat, lon: s.lon, heading: s.heading, speed: s.speed, name: s.name, type: s.type });
  }
  return out;
}

/**
 * Single-ship lookup by id (the AIS snapshot key) — backs the /radar/ships/:id
 * detail panel. Reads the in-memory snapshot; null when not currently tracked.
 */
export function getShipById(id: string): Ship | null {
  if (!ensureStarted()) return null;
  const s = snapshot.get(id);
  if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null;
  return { id: s.id, lat: s.lat, lon: s.lon, heading: s.heading, speed: s.speed, name: s.name, type: s.type };
}
