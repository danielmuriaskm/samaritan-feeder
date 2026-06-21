import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  getAllIpCameras,
  getIpCameraCategories,
  getIpCamerasByCategory,
  searchIpCamerasNear,
  searchIpCamerasByName,
  getIpCamerasInBounds,
  getIpCameraMetadata,
} from '../geo/ipCameraLibrary.js';
import { parseLocation } from '../geo/utils.js';
import { createSource } from '../store/sources.js';

const app = new Hono();

let cachedCamerasJson: string | undefined;
let cachedCategoriesJson: string | undefined;

app.get('/', async (c) => {
  if (!cachedCategoriesJson) {
    cachedCategoriesJson = JSON.stringify({
      metadata: getIpCameraMetadata(),
      categories: getIpCameraCategories(),
    });
  }
  return c.newResponse(cachedCategoriesJson, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  });
});

app.get('/cameras', async (c) => {
  const category = c.req.query('category');
  const query = c.req.query('q');
  const near = c.req.query('near');
  const bounds = c.req.query('bounds');
  const radius = Number(c.req.query('radius') ?? 50);

  if (near) {
    const point = parseLocation(near);
    if (!point) return c.json({ error: 'Invalid near format. Use lat,lon' }, 400);
    const results = searchIpCamerasNear(point, radius);
    return c.json({ cameras: results });
  }

  if (query) {
    return c.json({ cameras: searchIpCamerasByName(query) });
  }

  if (category) {
    return c.json({ cameras: getIpCamerasByCategory(category) });
  }

  if (bounds) {
    const [minLat, minLon, maxLat, maxLon] = bounds.split(',').map(Number);
    if ([minLat, minLon, maxLat, maxLon].some((n) => Number.isNaN(n))) {
      return c.json({ error: 'Invalid bounds. Use minLat,minLon,maxLat,maxLon' }, 400);
    }
    return c.json({ cameras: getIpCamerasInBounds(minLat, minLon, maxLat, maxLon) });
  }

  if (!cachedCamerasJson) {
    cachedCamerasJson = JSON.stringify({ cameras: getAllIpCameras() });
  }
  return c.newResponse(cachedCamerasJson, 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
  });
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

  const all = getAllIpCameras();
  const toImport = all.filter((w) => parsed.data.names.includes(w.name));
  const imported: Array<{ name: string; id: string }> = [];
  const failed: Array<{ name: string; reason: string }> = [];

  for (const cam of toImport) {
    try {
      const source = await createSource({
        id: randomUUID(),
        kind: 'ip_camera',
        name: cam.name,
        description: `${cam.manufacturer.toUpperCase()} — ${cam.region}, ${cam.country} (port ${cam.port})`,
        config: {
          url: cam.streamUrl ?? cam.infoUrl,
          infoUrl: cam.infoUrl,
          streamUrl: cam.streamUrl,
          streamType: cam.streamType ?? 'rtsp',
          sourceId: cam.name,
          frameIntervalSeconds: 60,
          motionThreshold: 0.05,
          lat: cam.lat,
          lon: cam.lon,
          timezone: cam.timezone,
          manufacturer: cam.manufacturer,
          port: cam.port,
        },
        enabled: true,
        pollIntervalSeconds: 60,
        errorCount: 0,
        createdByUserId: parsed.data.createdByUserId,
      });
      imported.push({ name: cam.name, id: source.id });
    } catch (err) {
      failed.push({ name: cam.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({ imported, failed, total: toImport.length }, 201);
});

export default app;
