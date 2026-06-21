/**
 * Offline geo resolver.
 *
 * Turns the lat/lon the feeder already stores on events into filterable,
 * correlatable tags: an ISO-3166-1 alpha-2 country code and a coarse strategic
 * region. Fully offline and dependency-free -- no reverse-geocoding service, no
 * network. Backed by a hand-authored bounding-box table (src/data/country-bboxes.json).
 *
 * Method inspiration (clean-room): worldmonitor (AGPL-3.0) bins incidents into
 * countries/regions for convergence; this is an independent implementation with
 * its own data tables, region map, and disambiguation rule. No code or data
 * copied.
 *
 * Accuracy posture: bbox containment is intentionally coarse. Rectangles overlap
 * near borders and over oceans, so this is a prefilter, not a survey-grade
 * geocoder. When several country boxes contain a point we pick the smallest-area
 * box, which heavily favors the more specific (smaller) country over a continental
 * giant whose rectangle happens to span the point.
 */

import bboxJson from '../data/country-bboxes.json' with { type: 'json' };
import type { GeoPoint } from './utils.js';

/** [minLon, minLat, maxLon, maxLat] in WGS84 degrees. */
type Bbox = [number, number, number, number];

interface BboxFile {
  version: string;
  description: string;
  boxes: Record<string, Bbox[]>;
}

const data = bboxJson as unknown as BboxFile;

/**
 * Flattened (iso, box, area) list, precomputed once at module load so
 * resolveCountry is a single linear scan with no per-call allocation.
 */
interface CountryBox {
  iso: string;
  box: Bbox;
  area: number;
}

const COUNTRY_BOXES: CountryBox[] = (() => {
  const out: CountryBox[] = [];
  for (const [iso, boxes] of Object.entries(data.boxes)) {
    for (const box of boxes) {
      out.push({ iso, box, area: bboxArea(box) });
    }
  }
  // Smallest area first: the first containing box we accept is already the most
  // specific, but we keep the explicit min-area comparison in resolveCountry to
  // stay correct regardless of ordering.
  out.sort((a, b) => a.area - b.area);
  return out;
})();

function bboxArea(box: Bbox): number {
  const [minLon, minLat, maxLon, maxLat] = box;
  return Math.abs(maxLon - minLon) * Math.abs(maxLat - minLat);
}

function lonLatInBox(lat: number, lon: number, box: Bbox): boolean {
  const [minLon, minLat, maxLon, maxLat] = box;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function validCoord(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Resolve coordinates to an ISO-3166-1 alpha-2 country code.
 * Returns undefined for ocean / unmapped points or invalid coordinates.
 *
 * Disambiguation: when several country boxes contain the point, the
 * smallest-area box wins (a more specific small country beats a continental
 * rectangle that merely spans the point).
 */
export function resolveCountry(lat: number, lon: number): string | undefined {
  if (!validCoord(lat, lon)) return undefined;
  let best: CountryBox | undefined;
  for (const cb of COUNTRY_BOXES) {
    if (!lonLatInBox(lat, lon, cb.box)) continue;
    if (!best || cb.area < best.area) best = cb;
  }
  return best?.iso;
}

/**
 * Coarse strategic regions. Independent, opinionated map -- not a copy of any
 * external taxonomy. Boxes are evaluated smallest-area first so a tight region
 * (e.g. MENA) wins over a broad one (e.g. AFRICA) where they overlap.
 *
 * [minLon, minLat, maxLon, maxLat].
 */
const REGION_BOXES: Array<{ region: string; box: Bbox }> = [
  // Europe (incl. UK, Iberia, Nordics, Balkans, western Russia up to the Urals).
  { region: 'EU', box: [-31.0, 34.5, 40.0, 71.5] },
  // Middle East + North Africa.
  { region: 'MENA', box: [-17.5, 12.0, 63.5, 42.5] },
  // Sub-Saharan Africa.
  { region: 'AFRICA', box: [-18.0, -35.5, 51.5, 22.0] },
  // East Asia.
  { region: 'EAST_ASIA', box: [100.0, 18.0, 146.0, 54.0] },
  // South Asia.
  { region: 'SOUTH_ASIA', box: [60.0, 5.0, 97.5, 38.5] },
  // Southeast Asia + maritime.
  { region: 'SOUTHEAST_ASIA', box: [92.0, -11.0, 141.0, 23.5] },
  // Central Asia + Caucasus.
  { region: 'CENTRAL_ASIA', box: [40.0, 36.0, 88.0, 56.0] },
  // North Asia (Siberia / Russian Far East beyond the Urals).
  { region: 'NORTH_ASIA', box: [40.0, 41.0, 180.0, 78.0] },
  // North America (north of the Mexico/Guatemala line).
  { region: 'NORTH_AMERICA', box: [-168.0, 14.5, -52.0, 72.0] },
  // South + Central America.
  { region: 'LATAM', box: [-93.0, -56.0, -34.0, 14.5] },
  // Oceania.
  { region: 'OCEANIA', box: [110.0, -48.0, 180.0, 0.0] },
];

const REGION_BOXES_BY_AREA = [...REGION_BOXES].sort(
  (a, b) => bboxArea(a.box) - bboxArea(b.box),
);

/**
 * Authoritative country -> region map. Used FIRST in resolveRegion: where the
 * bbox geometry of two regions overlaps (Iberia vs. the MENA box's northern
 * edge, the Levant vs. the EU box, etc.) the country answer is unambiguous, so
 * we trust it and only fall back to region boxes for points that resolve to no
 * country (e.g. a sea point near a coast). Codes not listed fall through to the
 * geometric region scan.
 */
const COUNTRY_REGION: Record<string, string> = {
  // Europe
  GB: 'EU', IE: 'EU', FR: 'EU', ES: 'EU', PT: 'EU', DE: 'EU', IT: 'EU',
  CH: 'EU', AT: 'EU', NL: 'EU', BE: 'EU', PL: 'EU', CZ: 'EU', SE: 'EU',
  NO: 'EU', FI: 'EU', DK: 'EU', GR: 'EU', RO: 'EU', UA: 'EU', HU: 'EU',
  RS: 'EU', HR: 'EU', BG: 'EU',
  // MENA
  TR: 'MENA', IL: 'MENA', PS: 'MENA', LB: 'MENA', SY: 'MENA', JO: 'MENA',
  IQ: 'MENA', IR: 'MENA', SA: 'MENA', AE: 'MENA', QA: 'MENA', KW: 'MENA',
  YE: 'MENA', OM: 'MENA', EG: 'MENA', LY: 'MENA', TN: 'MENA', DZ: 'MENA',
  MA: 'MENA', MR: 'MENA',
  // Sub-Saharan Africa
  ML: 'AFRICA', NG: 'AFRICA', GH: 'AFRICA', CI: 'AFRICA', SN: 'AFRICA',
  ET: 'AFRICA', KE: 'AFRICA', TZ: 'AFRICA', UG: 'AFRICA', ZA: 'AFRICA',
  ZW: 'AFRICA', ZM: 'AFRICA', AO: 'AFRICA', CD: 'AFRICA', SD: 'AFRICA',
  SS: 'AFRICA', SO: 'AFRICA',
  // South Asia
  IN: 'SOUTH_ASIA', PK: 'SOUTH_ASIA', AF: 'SOUTH_ASIA', BD: 'SOUTH_ASIA',
  LK: 'SOUTH_ASIA', NP: 'SOUTH_ASIA',
  // East Asia
  CN: 'EAST_ASIA', MN: 'EAST_ASIA', KP: 'EAST_ASIA', KR: 'EAST_ASIA',
  JP: 'EAST_ASIA', TW: 'EAST_ASIA',
  // Southeast Asia
  VN: 'SOUTHEAST_ASIA', TH: 'SOUTHEAST_ASIA', MM: 'SOUTHEAST_ASIA',
  KH: 'SOUTHEAST_ASIA', LA: 'SOUTHEAST_ASIA', MY: 'SOUTHEAST_ASIA',
  ID: 'SOUTHEAST_ASIA', PH: 'SOUTHEAST_ASIA', SG: 'SOUTHEAST_ASIA',
  // Central Asia + Caucasus
  KZ: 'CENTRAL_ASIA', UZ: 'CENTRAL_ASIA', GE: 'CENTRAL_ASIA',
  AM: 'CENTRAL_ASIA', AZ: 'CENTRAL_ASIA',
  // North America
  US: 'NORTH_AMERICA', CA: 'NORTH_AMERICA', MX: 'NORTH_AMERICA',
  // Latin America
  GT: 'LATAM', CU: 'LATAM', BR: 'LATAM', AR: 'LATAM', CL: 'LATAM',
  PE: 'LATAM', CO: 'LATAM', VE: 'LATAM', BO: 'LATAM', EC: 'LATAM',
  // Oceania
  AU: 'OCEANIA', NZ: 'OCEANIA', PG: 'OCEANIA',
  // Russia spans NORTH_ASIA / EU; treat the country as NORTH_ASIA at this
  // coarseness (the western-Russia / Kaliningrad case is a knowingly lossy edge).
  RU: 'NORTH_ASIA',
};

/**
 * Resolve coordinates to a coarse strategic region (e.g. 'EU', 'MENA',
 * 'EAST_ASIA', 'NORTH_AMERICA'). Returns undefined for ocean / unmapped points
 * or invalid coordinates.
 *
 * Strategy: resolve the country first and use its mapped region (unambiguous);
 * for points over water / unmapped land that yield no country, fall back to a
 * geometric region scan (smallest matching region wins).
 */
export function resolveRegion(lat: number, lon: number): string | undefined {
  if (!validCoord(lat, lon)) return undefined;
  const country = resolveCountry(lat, lon);
  if (country) {
    const mapped = COUNTRY_REGION[country];
    if (mapped) return mapped;
  }
  for (const r of REGION_BOXES_BY_AREA) {
    if (lonLatInBox(lat, lon, r.box)) return r.region;
  }
  return undefined;
}

/**
 * Ray-casting point-in-polygon test. Not used by the v1 bbox resolver, but
 * exported so future callers can refine a bbox hit with a real polygon without
 * pulling in a geo dependency. `polygon` is a ring of [lon, lat] vertices.
 */
export function pointInPolygon(lat: number, lon: number, polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; // lon, lat
    const [xj, yj] = polygon[j];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Minimal shape we need from an event: only its optional location. */
interface GeoTaggable {
  location?: GeoPoint | null;
}

/**
 * Derive geo tags {country?, region?} from an event's location, to be merged
 * into event.tags. Returns {} when the event has no usable location, so callers
 * can spread the result unconditionally.
 */
export function tagLocation(event: GeoTaggable): Record<string, unknown> {
  const loc = event.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return {};
  const tags: Record<string, unknown> = {};
  const country = resolveCountry(loc.lat, loc.lon);
  if (country) tags.country = country;
  const region = resolveRegion(loc.lat, loc.lon);
  if (region) tags.region = region;
  return tags;
}
