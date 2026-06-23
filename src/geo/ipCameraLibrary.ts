/**
 * Geoindexed IP camera library — now backed by the `public.cameras` PostGIS table
 * (see cameraStore.ts) instead of a 10.5MB in-heap JSON import. "IP cameras" are
 * reconstructed from the merged table via the insecam-family + RTSP heuristic.
 */

import type { GeoPoint } from './utils.js';
import {
  camerasNear,
  camerasInBounds,
  camerasByName,
  camerasByCategory,
  camerasByNames,
  allCameras,
  cameraCategories,
  cameraCount,
  type CameraRecord,
} from './cameraStore.js';

export interface IpCameraEntry {
  name: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  infoUrl: string;
  streamUrl: string | null;
  // Relaxed from the old 'rtsp' | null: the merged table carries image/hls/rtsp.
  streamType: string | null;
  provider: string;
  timezone: string;
  manufacturer: string;
  port: number;
  category: string;
}

const prettify = (key: string): string => key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

/** public.cameras has no `port` column; it's metadata only (streamUrl carries the
 * real port), so default 0. manufacturer is nullable in the table -> 'unknown'. */
function toIp(r: CameraRecord): IpCameraEntry {
  return {
    name: r.name,
    country: r.country,
    region: r.region,
    lat: r.lat,
    lon: r.lon,
    infoUrl: r.infoUrl ?? '',
    streamUrl: r.streamUrl,
    streamType: r.streamType,
    provider: r.provider,
    timezone: r.timezone,
    manufacturer: r.manufacturer ?? 'unknown',
    port: 0,
    category: r.category,
  };
}

export async function getAllIpCameras(): Promise<IpCameraEntry[]> {
  return (await allCameras('ip')).map(toIp);
}

export async function getIpCamerasByNames(names: string[]): Promise<IpCameraEntry[]> {
  return (await camerasByNames('ip', names)).map(toIp);
}

export async function getIpCamerasByCategory(category: string): Promise<IpCameraEntry[]> {
  return (await camerasByCategory('ip', category)).map(toIp);
}

export async function getIpCameraCategories(): Promise<Array<{ key: string; name: string; description: string; count: number }>> {
  const cats = await cameraCategories('ip');
  return cats.map((c) => ({ key: c.category, name: prettify(c.category), description: '', count: c.count }));
}

export async function searchIpCamerasNear(
  point: GeoPoint,
  radiusKm: number,
): Promise<Array<IpCameraEntry & { distanceKm: number }>> {
  const rows = await camerasNear('ip', point, radiusKm);
  return rows.map((r) => ({ ...toIp(r), distanceKm: r.distanceKm ?? 0 }));
}

export async function searchIpCamerasByName(query: string): Promise<IpCameraEntry[]> {
  return (await camerasByName('ip', query)).map(toIp);
}

export async function getIpCamerasInBounds(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  limit?: number,
): Promise<IpCameraEntry[]> {
  return (await camerasInBounds('ip', minLat, minLon, maxLat, maxLon, limit)).map(toIp);
}

export async function getIpCameraMetadata(): Promise<{ total_cameras: number; last_updated: string; version: string }> {
  return { total_cameras: await cameraCount('ip'), last_updated: new Date().toISOString(), version: 'db' };
}
