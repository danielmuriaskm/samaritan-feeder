import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { createSource } from '../store/sources.js';

const API_BASE = 'https://api.windy.com/webcams/api/v3';

function getApiKey(fallback = false): string {
  if (fallback) return config.WINDY_API_KEY2 ?? config.WINDY_API_KEY ?? '';
  return config.WINDY_API_KEY ?? config.WINDY_API_KEY2 ?? '';
}

const app = new Hono();

app.get('/categories', async (c) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    return c.json({ error: 'WINDY_API_KEY not configured' }, 503);
  }

  try {
    const res = await fetch(`${API_BASE}/categories`, {
      headers: {
        'x-windy-api-key': apiKey,
        'User-Agent': 'Samaritan-Feeder/0.1',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return c.json({ error: `Windy API error: ${res.status}`, detail: text }, 502);
    }

    const data = await res.json();
    return c.json({ categories: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Proxy failed', message }, 502);
  }
});

app.get('/search', async (c) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    return c.json({ error: 'WINDY_API_KEY not configured' }, 503);
  }

  const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);
  const offset = Number(c.req.query('offset') ?? 0);
  const country = c.req.query('country');
  const category = c.req.query('category');
  const nearby = c.req.query('nearby');
  const nearbyRadius = c.req.query('nearbyRadius');
  const webcamIds = c.req.query('webcamIds');
  const lang = c.req.query('lang') ?? 'en';
  const include = c.req.query('include') ?? 'images,location,urls,categories';

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('lang', lang);
  params.set('include', include);
  if (country) params.set('country', country);
  if (category) params.set('category', category);
  if (nearby) {
    params.set('nearby', nearby);
    params.set('nearbyRadius', nearbyRadius ?? '50');
  }
  if (webcamIds) params.set('webcamIds', webcamIds);

  try {
    const res = await fetch(`${API_BASE}/webcams?${params.toString()}`, {
      headers: {
        'x-windy-api-key': apiKey,
        'User-Agent': 'Samaritan-Feeder/0.1',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return c.json({ error: `Windy API error: ${res.status}`, detail: text }, 502);
    }

    const data = await res.json();
    return c.json({ webcams: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Proxy failed', message }, 502);
  }
});

app.post('/import', async (c) => {
  const schema = z.object({
    webcams: z.array(
      z.object({
        webcamId: z.string(),
        title: z.string().optional(),
        location: z
          .object({
            lat: z.number().optional(),
            lon: z.number().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            city: z.string().optional(),
            country: z.string().optional(),
            countryCode: z.string().optional(),
          })
          .optional(),
        category: z.string().optional(),
        images: z
          .object({
            current: z
              .object({
                preview: z.string().optional(),
                thumbnail: z.string().optional(),
              })
              .optional(),
            daylight: z
              .object({
                preview: z.string().optional(),
                thumbnail: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    ),
    pollIntervalSeconds: z.number().int().min(60).max(86400).default(300),
    createdByUserId: z.string().optional(),
  });

  const body = await c.req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const imported: Array<{ name: string; id: string }> = [];
  const failed: Array<{ name: string; reason: string }> = [];

  for (const cam of parsed.data.webcams) {
    const name = cam.title ?? `Windy webcam ${cam.webcamId}`;
    try {
      const loc = cam.location;
      const source = await createSource({
        id: randomUUID(),
        kind: 'windy',
        name,
        description: loc
          ? `Windy webcam — ${[loc.city, loc.country].filter(Boolean).join(', ')}`
          : 'Windy webcam',
        config: {
          webcamIds: cam.webcamId,
          limit: 1,
          lang: 'en',
          include: 'images,location,urls,categories',
          category: cam.category,
          sourceId: `windy_${cam.webcamId}`,
          lat: cam.location?.latitude ?? cam.location?.lat,
          lon: cam.location?.longitude ?? cam.location?.lon,
          country: cam.location?.country,
          city: cam.location?.city,
          previewUrl:
            cam.images?.current?.preview ??
            cam.images?.current?.thumbnail ??
            cam.images?.daylight?.preview ??
            null,
        },
        enabled: true,
        pollIntervalSeconds: parsed.data.pollIntervalSeconds,
        errorCount: 0,
        createdByUserId: parsed.data.createdByUserId,
      });
      imported.push({ name, id: source.id });
    } catch (err) {
      failed.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({ imported, failed, total: parsed.data.webcams.length }, 201);
});

export default app;
