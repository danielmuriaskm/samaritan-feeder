import exifr from 'exifr';
const parse = exifr.parse;

export interface ExifLocation {
  lat: number;
  lon: number;
  altitude?: number;
}

export async function extractLocationFromUrl(imageUrl: string): Promise<ExifLocation | undefined> {
  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Samaritan-Feeder/0.1' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return undefined;

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const gps = await parse(buffer, {
      gps: true,
      translateKeys: false,
      translateValues: false,
    });

    if (!gps || typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') {
      return undefined;
    }

    return {
      lat: gps.latitude,
      lon: gps.longitude,
      altitude: typeof gps.altitude === 'number' ? gps.altitude : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function enrichEventWithExifLocation(
  mediaUrls: string[] | undefined,
): Promise<ExifLocation | undefined> {
  if (!mediaUrls || mediaUrls.length === 0) return undefined;

  for (const url of mediaUrls) {
    const loc = await extractLocationFromUrl(url);
    if (loc) return loc;
  }

  return undefined;
}
