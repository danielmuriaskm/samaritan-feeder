/**
 * Geoindexed webcam library — now backed by the `public.cameras` PostGIS table
 * (see cameraStore.ts) instead of a 67MB in-heap JSON import. Same exported shape;
 * the functions are async (they hit the DB) and bounded/near/name queries are
 * served by GIST/trgm indexes rather than full in-memory scans.
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
} from './cameraStore.js';

export interface WebcamEntry {
  name: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  infoUrl: string | null;
  streamUrl: string | null;
  streamType: string | null;
  provider: string;
  timezone: string;
  category: string;
}

/** Prettify a raw category key (e.g. "uk_traffic" -> "Uk Traffic") for browse UIs. */
const prettify = (key: string): string => key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

export async function getAllWebcams(): Promise<WebcamEntry[]> {
  return allCameras('webcam');
}

export async function getWebcamsByNames(names: string[]): Promise<WebcamEntry[]> {
  return camerasByNames('webcam', names);
}

export async function getWebcamsByCategory(category: string): Promise<WebcamEntry[]> {
  return camerasByCategory('webcam', category);
}

export async function getCategories(): Promise<Array<{ key: string; name: string; description: string; count: number }>> {
  const cats = await cameraCategories('webcam');
  return cats.map((c) => ({ key: c.category, name: prettify(c.category), description: '', count: c.count }));
}

export async function searchWebcamsNear(
  point: GeoPoint,
  radiusKm: number,
): Promise<Array<WebcamEntry & { distanceKm: number }>> {
  return (await camerasNear('webcam', point, radiusKm)) as Array<WebcamEntry & { distanceKm: number }>;
}

export async function searchWebcamsByName(query: string): Promise<WebcamEntry[]> {
  return camerasByName('webcam', query);
}

export async function getWebcamsInBounds(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  limit?: number,
): Promise<WebcamEntry[]> {
  return camerasInBounds('webcam', minLat, minLon, maxLat, maxLon, limit);
}

export async function getMetadata(): Promise<{ total_cameras: number; last_updated: string; license?: string }> {
  return { total_cameras: await cameraCount('webcam'), last_updated: new Date().toISOString(), license: 'public sources' };
}
