import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getAllWebcams, getCategories, getWebcamsByCategory, searchWebcamsNear, searchWebcamsByName, getWebcamsInBounds, getMetadata, getWebcamsByNames } from '../geo/webcamLibrary.js';
import { parseLocation } from '../geo/utils.js';
import { createSource } from '../store/sources.js';
import { importOpenTrafficCamMap } from '../geo/openTrafficCamMap.js';

const app = new Hono();

// Categories metadata only (a few KB). The full webcam list is intentionally NOT
// cached server-side — it was a retained ~97MB string pinned for the process life.
let cachedCategoriesJson: string | undefined;

app.get('/', async (c) => {
  if (!cachedCategoriesJson) {
    cachedCategoriesJson = JSON.stringify({
      metadata: await getMetadata(),
      categories: await getCategories(),
    });
  }
  return c.newResponse(cachedCategoriesJson, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  });
});

app.get('/webcams', async (c) => {
  const category = c.req.query('category');
  const query = c.req.query('q');
  const near = c.req.query('near');
  const bounds = c.req.query('bounds');
  const radius = Number(c.req.query('radius') ?? 50);

  if (near) {
    const point = parseLocation(near);
    if (!point) return c.json({ error: 'Invalid near format. Use lat,lon' }, 400);
    const results = await searchWebcamsNear(point, radius);
    return c.json({ webcams: results });
  }

  if (query) {
    return c.json({ webcams: await searchWebcamsByName(query) });
  }

  if (category) {
    return c.json({ webcams: await getWebcamsByCategory(category) });
  }

  if (bounds) {
    const [minLat, minLon, maxLat, maxLon] = bounds.split(',').map(Number);
    if ([minLat, minLon, maxLat, maxLon].some((n) => Number.isNaN(n))) {
      return c.json({ error: 'Invalid bounds. Use minLat,minLon,maxLat,maxLon' }, 400);
    }
    return c.json({ webcams: await getWebcamsInBounds(minLat, minLon, maxLat, maxLon) });
  }

  // Built on demand (capped in the DB layer). Clients/CDN still cache via the header.
  return c.json({ webcams: await getAllWebcams() }, 200, { 'Cache-Control': 'public, max-age=3600' });
});

app.post('/import', async (c) => {
  const schema = z.object({
    names: z.array(z.string()).min(1),
    createdByUserId: z.string().optional(),
  });

  const body = await c.req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const toImport = await getWebcamsByNames(parsed.data.names);
  const imported: Array<{ name: string; id: string }> = [];
  const failed: Array<{ name: string; reason: string }> = [];

  for (const webcam of toImport) {
    try {
      const source = await createSource({
        id: randomUUID(),
        kind: 'webcam',
        name: webcam.name,
        description: `${webcam.provider} — ${webcam.region}, ${webcam.country}`,
        config: {
          url: webcam.streamUrl ?? webcam.infoUrl,
          infoUrl: webcam.infoUrl,
          streamUrl: webcam.streamUrl,
          streamType: webcam.streamType,
          sourceId: webcam.name,
          frameIntervalSeconds: 60,
          motionThreshold: 0.05,
          lat: webcam.lat,
          lon: webcam.lon,
          timezone: webcam.timezone,
        },
        enabled: true,
        pollIntervalSeconds: 60,
        errorCount: 0,
        createdByUserId: parsed.data.createdByUserId,
      });
      imported.push({ name: webcam.name, id: source.id });
    } catch (err) {
      failed.push({ name: webcam.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({ imported, failed, total: toImport.length }, 201);
});

app.post('/import-opentraffic', async (c) => {
  const result = await importOpenTrafficCamMap();
  return c.json(result, 201);
});

export default app;
