import { randomUUID } from 'crypto';
import { createSource } from '../store/sources.js';

interface OtcCamera {
  location?: {
    lat?: number;
    lon?: number;
    city?: string;
    region?: string;
    country?: string;
  };
  encoding?: string;
  format?: string;
  url?: string;
  image_url?: string;
  source_url?: string;
}

const COUNTRIES = [
  'US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI',
  'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'EE', 'LV', 'LT', 'IE', 'PT', 'GR', 'TR',
  'AU', 'NZ', 'JP', 'KR', 'SG', 'MY', 'TH', 'ID', 'PH', 'VN', 'IN', 'CN', 'TW', 'HK', 'AE',
  'SA', 'IL', 'ZA', 'BR', 'AR', 'CL', 'CO', 'PE', 'MX', 'RU', 'UA', 'BY',
];

export async function importOpenTrafficCamMap(): Promise<{
  imported: number;
  failed: number;
  total: number;
}> {
  let imported = 0;
  let failed = 0;
  let total = 0;

  for (const country of COUNTRIES) {
    try {
      const url = `https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/master/cameras/${country}.json`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Samaritan-Feeder/0.1' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;

      const data = (await res.json()) as Record<string, OtcCamera>;
      const cameras = Object.entries(data);

      for (const [name, cam] of cameras) {
        total++;
        try {
          const lat = cam.location?.lat ?? 0;
          const lon = cam.location?.lon ?? 0;
          if (lat === 0 && lon === 0) continue;

          await createSource({
            id: randomUUID(),
            kind: 'traffic_cam',
            name: `${country}: ${name}`,
            description: `OpenTrafficCamMap — ${cam.location?.city ?? ''}, ${cam.location?.region ?? ''} (${cam.format ?? 'unknown'})`,
            config: {
              url: cam.url ?? cam.image_url ?? cam.source_url,
              streamUrl: cam.url,
              streamType: cam.format?.toLowerCase().includes('m3u8') ? 'hls' : 'image',
              sourceId: name,
              lat,
              lon,
              country: cam.location?.country ?? country,
              region: cam.location?.region ?? cam.location?.city ?? '',
              encoding: cam.encoding,
              format: cam.format,
            },
            enabled: true,
            pollIntervalSeconds: 60,
            errorCount: 0,
          });
          imported++;
        } catch {
          failed++;
        }
      }
    } catch {
      // skip countries that don't exist or fail
    }
  }

  return { imported, failed, total };
}
