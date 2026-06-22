// Pure, dependency-free radar helpers for the live ADS-B / AIS map layers.
//
// Clean-room reimplementation of the worldmonitor radar *behaviors* (altitude-band
// coloring, client-side position trails, type-aware icon classification). No
// worldmonitor code is used — these are independent implementations of the same ideas
// expressed against the feeder's own Aircraft/Ship shapes (see lib/api.ts).
//
// Keep this file free of React / leaflet imports so it can be unit-reasoned about and
// reused by the icon builders that emit raw HTML strings.

import type { Aircraft, Ship } from './api.js';

// ----- Altitude bands ----------------------------------------------------------
// Discrete bands (for the legend + the altitude range filter) layered on top of a
// continuous gradient (for per-aircraft marker/trail color). Thresholds in feet.
export interface AltBand {
  key: string;
  label: string;
  min: number; // inclusive feet
  max: number; // exclusive feet (Infinity for the top band)
  color: string; // representative hex for the legend swatch
}

export const ALT_BANDS: AltBand[] = [
  { key: 'ground', label: 'Ground', min: -Infinity, max: 100, color: '#888888' },
  { key: 'low', label: 'Low · <5k', min: 100, max: 5000, color: '#00d9ff' },
  { key: 'mid', label: 'Mid · 5–20k', min: 5000, max: 20000, color: '#c8e63c' },
  { key: 'high', label: 'High · 20–35k', min: 20000, max: 35000, color: '#ffa51e' },
  { key: 'cruise', label: 'Cruise · 35k+', min: 35000, max: Infinity, color: '#eb3237' },
];

export function altBandFor(altFt: number | null | undefined): AltBand {
  const alt = typeof altFt === 'number' && Number.isFinite(altFt) ? altFt : 0;
  for (const b of ALT_BANDS) {
    if (alt >= b.min && alt < b.max) return b;
  }
  return ALT_BANDS[ALT_BANDS.length - 1]!;
}

// Continuous cyan → green → yellow-green → orange → deep-orange → red gradient,
// piecewise-linear between stops. Mirrors the worldmonitor altitude→hue idea but
// with our own stop table. Ground / unknown reads as the grey ground band.
const ALT_STOPS: Array<{ alt: number; r: number; g: number; b: number }> = [
  { alt: 0, r: 0, g: 217, b: 255 }, // #00d9ff cyan (sea level)
  { alt: 5000, r: 50, g: 250, b: 160 }, // green
  { alt: 10000, r: 200, g: 230, b: 60 }, // yellow-green
  { alt: 20000, r: 255, g: 165, b: 30 }, // orange
  { alt: 30000, r: 255, g: 100, b: 35 }, // deep orange
  { alt: 40000, r: 235, g: 50, b: 55 }, // red
  { alt: 45000, r: 210, g: 40, b: 70 }, // crimson (top)
];

export function altitudeToColor(altFt: number | null | undefined): string {
  const alt = typeof altFt === 'number' && Number.isFinite(altFt) ? altFt : NaN;
  if (!Number.isFinite(alt) || alt < 100) return '#888888'; // ground / unknown
  const stops = ALT_STOPS;
  if (alt <= stops[0]!.alt) return rgbHex(stops[0]!.r, stops[0]!.g, stops[0]!.b);
  const last = stops[stops.length - 1]!;
  if (alt >= last.alt) return rgbHex(last.r, last.g, last.b);
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i]!;
    const lo = stops[i - 1]!;
    if (alt <= hi.alt) {
      const t = (alt - lo.alt) / (hi.alt - lo.alt);
      return rgbHex(
        Math.round(lo.r + (hi.r - lo.r) * t),
        Math.round(lo.g + (hi.g - lo.g) * t),
        Math.round(lo.b + (hi.b - lo.b) * t),
      );
    }
  }
  return rgbHex(last.r, last.g, last.b);
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ----- Type-aware classification ----------------------------------------------
// The radar feed gives free-text `type`. We bucket it into a small set of glyph
// categories so the marker can vary shape/size by what's flying / sailing.
export type AircraftCat = 'jet' | 'prop' | 'heli' | 'ground';
export type ShipCat = 'cargo' | 'tanker' | 'passenger' | 'other';

export function aircraftCategory(a: Pick<Aircraft, 'type' | 'alt' | 'speed'>): AircraftCat {
  const t = (a.type ?? '').toLowerCase();
  if (/heli|rotor|helicopter|\bh[0-9]|ec[0-9]|as[0-9]{2}|r44|r66|bell|aw1/.test(t)) return 'heli';
  // On (or near) the ground and slow → ground vehicle / taxiing.
  if ((a.alt == null || a.alt < 100) && (a.speed == null || a.speed < 40)) return 'ground';
  if (/prop|cessna|piper|c1[0-9]{2}|pa[0-9]{2}|tbm|king ?air|beech|piston|turbo ?prop|dhc|at[0-9]{2}|cub/.test(t)) {
    return 'prop';
  }
  return 'jet';
}

export function shipCategory(s: Pick<Ship, 'type'>): ShipCat {
  const t = (s.type ?? '').toLowerCase();
  if (/cargo|container|bulk|general|reefer/.test(t)) return 'cargo';
  if (/tanker|oil|gas|lng|lpg|chemical|crude/.test(t)) return 'tanker';
  if (/passenger|cruise|ferry|ro-?ro|ropax/.test(t)) return 'passenger';
  return 'other';
}

// ----- Client-side trail ring buffer ------------------------------------------
// The server returns only current positions, so per-id position history is
// accumulated here across refreshes. Bounded ring buffer; stale ids are evicted so
// vanished tracks don't leak memory or render ghost trails.
export const TRAIL_MAX_POINTS = 16;
const TRAIL_STALE_MS = 5 * 60 * 1000; // evict ids not seen for 5 min

export interface TrailPoint {
  lat: number;
  lon: number;
}
interface TrailEntry {
  points: TrailPoint[];
  lastUpdate: number;
}

export class TrailStore {
  private map = new Map<string, TrailEntry>();

  /** Append a position for `id`, returning the bounded point list (oldest → newest). */
  push(id: string, lat: number, lon: number, now = Date.now()): TrailPoint[] {
    let e = this.map.get(id);
    if (!e) {
      e = { points: [], lastUpdate: now };
      this.map.set(id, e);
    }
    const last = e.points[e.points.length - 1];
    // Skip exact-duplicate samples (no movement between refreshes).
    if (!last || last.lat !== lat || last.lon !== lon) {
      e.points.push({ lat, lon });
      if (e.points.length > TRAIL_MAX_POINTS) e.points.shift();
    }
    e.lastUpdate = now;
    return e.points;
  }

  get(id: string): TrailPoint[] {
    return this.map.get(id)?.points ?? [];
  }

  /** Drop ids that weren't present in `liveIds`, or that have gone stale. */
  prune(liveIds: Set<string>, now = Date.now()): void {
    for (const [id, e] of this.map) {
      if (!liveIds.has(id) || now - e.lastUpdate > TRAIL_STALE_MS) {
        this.map.delete(id);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
