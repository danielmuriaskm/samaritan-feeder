/**
 * Geoindexed IP camera library loader.
 * Provides public IP cameras organized by manufacturer with lat/lon coordinates.
 */

import libraryJson from '../data/ip-camera-library.json' with { type: 'json' };
import { haversineDistance } from './utils.js';
import type { GeoPoint } from './utils.js';

export interface IpCameraEntry {
  name: string;
  country: string;
  region: string;
  lat: number;
  lon: number;
  infoUrl: string;
  streamUrl: string | null;
  streamType: 'rtsp' | null;
  provider: string;
  timezone: string;
  manufacturer: string;
  port: number;
  category: string;
}

const library = libraryJson as unknown as {
  version: string;
  categories: Record<
    string,
    {
      name: string;
      description: string;
      sources: Array<{
        name: string;
        country: string;
        region: string;
        lat: number;
        lon: number;
        infoUrl: string;
        streamUrl: string | null;
        streamType: 'rtsp' | null;
        provider: string;
        timezone: string;
        manufacturer: string;
        port: number;
      }>;
    }
  >;
  metadata: { total_cameras: number; last_updated: string; version: string };
};

let cachedAllIpCameras: IpCameraEntry[] | undefined;

export function getAllIpCameras(): IpCameraEntry[] {
  if (cachedAllIpCameras) return cachedAllIpCameras;
  const entries: IpCameraEntry[] = [];
  for (const [categoryKey, category] of Object.entries(library.categories)) {
    for (const source of category.sources) {
      entries.push({ ...source, category: categoryKey });
    }
  }
  cachedAllIpCameras = entries;
  return entries;
}

export function getIpCamerasByCategory(category: string): IpCameraEntry[] {
  const cat = library.categories[category];
  if (!cat) return [];
  return cat.sources.map((s) => ({ ...s, category }));
}

export function getIpCameraCategories(): Array<{ key: string; name: string; description: string; count: number }> {
  return Object.entries(library.categories).map(([key, cat]) => ({
    key,
    name: cat.name,
    description: cat.description,
    count: cat.sources.length,
  }));
}

export function searchIpCamerasNear(point: GeoPoint, radiusKm: number): Array<IpCameraEntry & { distanceKm: number }> {
  const all = getAllIpCameras();
  return all
    .map((w) => ({ ...w, distanceKm: haversineDistance(point, { lat: w.lat, lon: w.lon }) }))
    .filter((w) => w.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function searchIpCamerasByName(query: string): IpCameraEntry[] {
  const q = query.toLowerCase();
  return getAllIpCameras().filter(
    (w) =>
      w.name.toLowerCase().includes(q) ||
      w.country.toLowerCase().includes(q) ||
      w.region.toLowerCase().includes(q) ||
      w.manufacturer.toLowerCase().includes(q),
  );
}

export function getIpCamerasInBounds(minLat: number, minLon: number, maxLat: number, maxLon: number): IpCameraEntry[] {
  const all = getAllIpCameras();
  const results: IpCameraEntry[] = [];
  for (const c of all) {
    if (c.lat >= minLat && c.lat <= maxLat && c.lon >= minLon && c.lon <= maxLon) {
      results.push(c);
    }
  }
  return results;
}

export function getIpCameraMetadata(): typeof library.metadata {
  return library.metadata;
}
