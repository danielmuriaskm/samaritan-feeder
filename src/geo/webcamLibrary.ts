/**
 * Geoindexed webcam library loader.
 * Provides curated public webcams organized by category with lat/lon coordinates.
 */

import libraryJson from '../data/webcam-library.json' with { type: 'json' };
import { haversineDistance } from './utils.js';
import type { GeoPoint } from './utils.js';

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

const library = libraryJson as unknown as {
  version: string;
  categories: Record<string, { name: string; description: string; sources: Array<{ name: string; country: string; region: string; lat: number; lon: number; infoUrl: string | null; streamUrl: string | null; streamType: string | null; provider: string; timezone: string }> }>;
  metadata: { total_cameras: number; last_updated: string; verification_method?: string; license?: string };
};

let cachedAllWebcams: WebcamEntry[] | undefined;

export function getAllWebcams(): WebcamEntry[] {
  if (cachedAllWebcams) return cachedAllWebcams;
  const entries: WebcamEntry[] = [];
  for (const [categoryKey, category] of Object.entries(library.categories)) {
    for (const source of category.sources) {
      entries.push({ ...source, category: categoryKey });
    }
  }
  cachedAllWebcams = entries;
  return entries;
}

export function getWebcamsByCategory(category: string): WebcamEntry[] {
  const cat = library.categories[category];
  if (!cat) return [];
  return cat.sources.map((s) => ({ ...s, category }));
}

export function getCategories(): Array<{ key: string; name: string; description: string; count: number }> {
  return Object.entries(library.categories).map(([key, cat]) => ({
    key,
    name: cat.name,
    description: cat.description,
    count: cat.sources.length,
  }));
}

export function searchWebcamsNear(point: GeoPoint, radiusKm: number): Array<WebcamEntry & { distanceKm: number }> {
  const all = getAllWebcams();
  return all
    .map((w) => ({ ...w, distanceKm: haversineDistance(point, { lat: w.lat, lon: w.lon }) }))
    .filter((w) => w.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export function searchWebcamsByName(query: string): WebcamEntry[] {
  const q = query.toLowerCase();
  return getAllWebcams().filter(
    (w) =>
      w.name.toLowerCase().includes(q) ||
      w.country.toLowerCase().includes(q) ||
      w.region.toLowerCase().includes(q) ||
      w.provider.toLowerCase().includes(q),
  );
}

export function getWebcamsInBounds(minLat: number, minLon: number, maxLat: number, maxLon: number): WebcamEntry[] {
  const all = getAllWebcams();
  const results: WebcamEntry[] = [];
  for (const w of all) {
    if (w.lat >= minLat && w.lat <= maxLat && w.lon >= minLon && w.lon <= maxLon) {
      results.push(w);
    }
  }
  return results;
}

export function getMetadata(): typeof library.metadata {
  return library.metadata;
}
