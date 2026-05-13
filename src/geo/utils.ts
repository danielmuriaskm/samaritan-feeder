/**
 * Geo utilities for intelligence feeder.
 * Haversine distance, bounding boxes, point-in-polygon, etc.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * Haversine distance between two points in kilometers.
 */
export function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const c = 2 * Math.atan2(
    Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon),
    Math.sqrt(1 - (sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon)),
  );

  return R * c;
}

/**
 * Compute a bounding box around a center point with given radius in km.
 */
export function boundingBox(center: GeoPoint, radiusKm: number): {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
} {
  const latDelta = radiusKm / 111.32;
  const lonDelta = radiusKm / (111.32 * Math.cos(toRad(center.lat)));

  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLon: center.lon - lonDelta,
    maxLon: center.lon + lonDelta,
  };
}

/**
 * Check if a point is inside a bounding box.
 */
export function pointInBox(point: GeoPoint, box: ReturnType<typeof boundingBox>): boolean {
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lon >= box.minLon &&
    point.lon <= box.maxLon
  );
}

/**
 * Parse a location string like "40.7128,-74.0060" into a GeoPoint.
 */
export function parseLocation(input: string): GeoPoint | null {
  const parts = input.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return { lat: parts[0], lon: parts[1] };
  }
  return null;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
