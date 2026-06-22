/**
 * DB-backed camera store — queries the `public.cameras` table (PostGIS) instead
 * of holding the 67MB+10.5MB webcam/ip-camera JSON libraries in heap.
 *
 * `public.cameras` (~199k rows) is the canonical, liveness-tracked superset of the
 * old static JSON libraries, and is fully indexed for these access patterns:
 *   - idx_cameras_geog   GIST(geog)            -> near (ST_DWithin) + bounds (&&)
 *   - idx_cameras_name_trgm GIN(name trgm)     -> name search (ilike)
 *   - idx_cameras_category / _country / _stream_type btrees
 *
 * The original two JSON files (webcam-library / ip-camera-library) were merged
 * into one table, so the webcam-vs-IP distinction is reconstructed heuristically:
 * the insecam-family directories + any RTSP stream are treated as "ip", everything
 * else as "webcam". (For the radar map the split is cosmetic — both are merged into
 * one marker list anyway.)
 */

import { query } from '../db.js';
import type { GeoPoint } from './utils.js';

export type CameraKind = 'webcam' | 'ip';

/** A row from public.cameras, column-aliased to the API's camelCase shape.
 * A `type` (not `interface`) so it satisfies the `query<T extends Record<...>>` bound. */
export type CameraRecord = {
  name: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  infoUrl: string | null;
  streamUrl: string | null;
  streamType: string | null;
  provider: string;
  category: string;
  manufacturer: string | null;
  timezone: string;
  distanceKm?: number;
};

// IP cameras = the insecam directories + anything served over RTSP. Webcam = the
// rest. `c.` prefix because the table is aliased `c` in every query below.
const IP_PREDICATE =
  "(c.category in ('insecam_17k','insecam_global','github_insecam','insecam_rtsp_speculative') or c.stream_type = 'rtsp')";
// Exclude cameras the liveness sweeper has marked dead (dead_at set) — ~42k of 199k.
// Applied to every kind-filtered query so the map/browse/counts only show live cams.
const LIVE = 'c.dead_at is null';
const pred = (kind: CameraKind): string => `${LIVE} and ${kind === 'ip' ? IP_PREDICATE : `not ${IP_PREDICATE}`}`;

const COLS =
  'c.name, c.country, c.region, c.lat, c.lon, c.info_url as "infoUrl", c.stream_url as "streamUrl", ' +
  'c.stream_type as "streamType", c.provider, c.category, c.manufacturer, c.timezone';

/** Hard safety cap so no single query can materialize the whole 199k table. */
const HARD_CAP = 5000;
const clampLimit = (n?: number): number => {
  const v = Number.isFinite(n) ? Math.floor(n as number) : HARD_CAP;
  return Math.max(1, Math.min(HARD_CAP, v));
};

export async function camerasNear(
  kind: CameraKind,
  point: GeoPoint,
  radiusKm: number,
  limit?: number,
): Promise<CameraRecord[]> {
  return query<CameraRecord>(
    `select ${COLS}, ST_Distance(c.geog, ST_MakePoint($1, $2)::geography) / 1000.0 as "distanceKm"
       from public.cameras c
      where ${pred(kind)}
        and ST_DWithin(c.geog, ST_MakePoint($1, $2)::geography, $3)
      order by "distanceKm"
      limit $4`,
    [point.lon, point.lat, Math.max(0, radiusKm) * 1000, clampLimit(limit)],
  );
}

export async function camerasInBounds(
  kind: CameraKind,
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  limit?: number,
): Promise<CameraRecord[]> {
  return query<CameraRecord>(
    `select ${COLS}
       from public.cameras c
      where ${pred(kind)}
        and c.geog && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
      limit $5`,
    [minLon, minLat, maxLon, maxLat, clampLimit(limit)],
  );
}

export async function camerasByName(kind: CameraKind, q: string, limit?: number): Promise<CameraRecord[]> {
  return query<CameraRecord>(
    `select ${COLS}
       from public.cameras c
      where ${pred(kind)}
        and (c.name ilike '%' || $1 || '%' or c.country ilike '%' || $1 || '%'
             or c.region ilike '%' || $1 || '%' or c.provider ilike '%' || $1 || '%'
             or c.manufacturer ilike '%' || $1 || '%')
      limit $2`,
    [q, clampLimit(limit)],
  );
}

export async function camerasByCategory(kind: CameraKind, category: string, limit?: number): Promise<CameraRecord[]> {
  return query<CameraRecord>(
    `select ${COLS} from public.cameras c where ${pred(kind)} and c.category = $1 limit $2`,
    [category, clampLimit(limit)],
  );
}

/** Exact-name lookup for the /import endpoints (was getAll().filter(names)). */
export async function camerasByNames(kind: CameraKind, names: string[]): Promise<CameraRecord[]> {
  if (names.length === 0) return [];
  return query<CameraRecord>(
    `select ${COLS} from public.cameras c where ${pred(kind)} and c.name = any($1::text[]) limit $2`,
    [names, HARD_CAP],
  );
}

/** Capped full list (the old getAll* returned everything; that was the heap blowup). */
export async function allCameras(kind: CameraKind, limit?: number): Promise<CameraRecord[]> {
  return query<CameraRecord>(`select ${COLS} from public.cameras c where ${pred(kind)} limit $1`, [clampLimit(limit)]);
}

export async function cameraCategories(kind: CameraKind): Promise<Array<{ category: string; count: number }>> {
  const rows = await query<{ category: string; count: string }>(
    `select c.category, count(*)::int as count from public.cameras c where ${pred(kind)} group by c.category order by count desc`,
  );
  return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
}

export async function cameraCount(kind: CameraKind): Promise<number> {
  const rows = await query<{ n: string }>(`select count(*)::int as n from public.cameras c where ${pred(kind)}`);
  return Number(rows[0]?.n ?? 0);
}

/** Total cameras (both kinds) — optionally within a bbox. Used by radar /count. */
export async function countCameras(bbox?: {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}): Promise<number> {
  if (bbox) {
    const rows = await query<{ n: string }>(
      `select count(*)::int as n from public.cameras c where ${LIVE} and c.geog && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography`,
      [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
    );
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await query<{ n: string }>(`select count(*)::int as n from public.cameras c where ${LIVE}`);
  return Number(rows[0]?.n ?? 0);
}
