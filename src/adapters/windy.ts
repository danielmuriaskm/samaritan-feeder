import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { config } from '../config.js';

const API_BASE = 'https://api.windy.com/webcams/api/v3/webcams';

interface WindyWebcam {
  webcamId: string;
  title?: string;
  location?: {
    lat?: number;
    lon?: number;
    city?: string;
    region?: string;
    country?: string;
    countryCode?: string;
  };
  images?: {
    current?: {
      icon?: string;
      thumbnail?: string;
      preview?: string;
      toenail?: string;
    };
    daylight?: {
      icon?: string;
      thumbnail?: string;
      preview?: string;
      toenail?: string;
    };
  };
  urls?: {
    detail?: string;
    edit?: string;
    update?: string;
  };
  player?: {
    day?: string;
    live?: string;
    month?: string;
    year?: string;
  };
  category?: string;
  status?: string;
  lastUpdated?: string;
}

export class WindyAdapter extends BaseAdapter {
  readonly kind = 'windy' as const;
  readonly name = 'Windy Webcams';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const apiKey = String(config.apiKey ?? '');
    const globalKey = String((config as Record<string, unknown>).windyApiKey ?? config.WINDY_API_KEY ?? '');

    if (!apiKey && !globalKey && !config.WINDY_API_KEY) {
      errors.push('Windy API key is required. Set WINDY_API_KEY in environment or config.apiKey');
    }
    if (config.limit !== undefined && typeof config.limit !== 'number') {
      errors.push('config.limit must be a number');
    }
    if (config.nearbyLat !== undefined && typeof config.nearbyLat !== 'number') {
      errors.push('config.nearbyLat must be a number');
    }
    if (config.nearbyLon !== undefined && typeof config.nearbyLon !== 'number') {
      errors.push('config.nearbyLon must be a number');
    }
    if (config.nearbyRadius !== undefined && typeof config.nearbyRadius !== 'number') {
      errors.push('config.nearbyRadius must be a number (km)');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const apiKey = this.resolveApiKey(config);
    const limit = typeof config.limit === 'number' ? Math.min(config.limit, 50) : 10;
    const rawOffset = cursor ? Number(cursor) : 0;
    const offset = rawOffset > 99000 ? 0 : rawOffset;
    const sourceId = String(config.sourceId ?? 'windy_unknown');
    const lang = String(config.lang ?? 'en');
    const include = String(config.include ?? 'images,location,urls,categories');

    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('lang', lang);
    params.set('include', include);

    if (config.country) params.set('country', String(config.country));
    if (config.category) params.set('category', String(config.category));
    if (typeof config.nearbyLat === 'number' && typeof config.nearbyLon === 'number') {
      params.set('nearby', `${config.nearbyLat},${config.nearbyLon}`);
      params.set('nearbyRadius', String(config.nearbyRadius ?? 50));
    }
    if (config.webcamIds) {
      params.set('webcamIds', String(config.webcamIds));
    }

    const url = `${API_BASE}?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        'x-windy-api-key': apiKey,
        'User-Agent': 'Samaritan-Feeder/0.1',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Windy API error: ${res.status} ${text}`);
    }

    const json = (await res.json()) as WindyWebcam[] | { data?: WindyWebcam[] };
    const webcams = Array.isArray(json) ? json : json.data ?? [];

    const events: RawEvent[] = [];
    const now = Date.now();

    for (const cam of webcams) {
      const imageUrl =
        cam.images?.current?.preview ??
        cam.images?.current?.thumbnail ??
        cam.images?.daylight?.preview ??
        cam.images?.daylight?.thumbnail ??
        null;

      if (!imageUrl) continue;

      const location = cam.location;
      const locationStr = [location?.city, location?.region, location?.country]
        .filter(Boolean)
        .join(', ');

      const timestamp = new Date().toISOString();
      const content = locationStr
        ? `Live webcam view from ${cam.title ?? 'Unknown location'} in ${locationStr}. Snapshot at ${timestamp}.`
        : `Live webcam view from ${cam.title ?? 'Unknown location'}. Snapshot at ${timestamp}.`;

      events.push(
        this.makeEvent(
          {
            kind: 'visual',
            title: cam.title ?? `Windy webcam ${cam.webcamId}`,
            content,
            rawData: cam as unknown as Record<string, unknown>,
            mediaUrls: [imageUrl],
            eventAt: now,
            confidence: 0.7,
            tags: {
              webcamId: cam.webcamId,
              category: cam.category,
              countryCode: location?.countryCode,
              city: location?.city,
              windyDetailUrl: cam.urls?.detail,
              source: 'windy.com',
            },
            location:
              location?.lat != null && location?.lon != null
                ? { lat: location.lat, lon: location.lon }
                : undefined,
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const apiKey = this.resolveApiKey(config);
    const start = performance.now();
    try {
      const res = await fetch(`${API_BASE}?limit=1`, {
        headers: { 'x-windy-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private resolveApiKey(cfg: Record<string, unknown>): string {
    return (
      String(cfg.apiKey ?? '') ||
      String((cfg as Record<string, unknown>).windyApiKey ?? '') ||
      String(config.WINDY_API_KEY ?? config.WINDY_API_KEY2 ?? '')
    );
  }
}
