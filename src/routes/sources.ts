import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { listSources, getSource, createSource, updateSource, deleteSource } from '../store/sources.js';
import { getAdapter } from '../adapters/index.js';

const app = new Hono();

/** Validate per-source CV geometry (config.cv.zones / lines) before saving. */
function validateCvConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const cv = config.cv as Record<string, unknown> | undefined;
  if (!cv || typeof cv !== 'object') return errors;

  const frac = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
  const point = (p: unknown, where: string) => {
    if (!Array.isArray(p) || p.length !== 2 || !frac(p[0]) || !frac(p[1])) {
      errors.push(`${where}: must be fractional [x,y] in 0..1`);
    }
  };

  if (cv.zones !== undefined) {
    if (!Array.isArray(cv.zones)) errors.push('cv.zones must be an array');
    else
      for (const z of cv.zones as Record<string, unknown>[]) {
        if (!z.id) errors.push('cv.zone: missing id');
        if (!Array.isArray(z.polygon) || z.polygon.length < 3) errors.push(`cv.zone ${z.id}: polygon needs >= 3 points`);
        else (z.polygon as unknown[]).forEach((p, i) => point(p, `cv.zone ${z.id} point ${i}`));
      }
  }
  if (cv.lines !== undefined) {
    if (!Array.isArray(cv.lines)) errors.push('cv.lines must be an array');
    else
      for (const l of cv.lines as Record<string, unknown>[]) {
        if (!l.id) errors.push('cv.line: missing id');
        point(l.start, `cv.line ${l.id} start`);
        point(l.end, `cv.line ${l.id} end`);
      }
  }
  if (cv.rules !== undefined) {
    const types = ['zone_breach', 'loitering', 'crowd_threshold', 'line_surge'];
    if (!Array.isArray(cv.rules)) errors.push('cv.rules must be an array');
    else
      for (const r of cv.rules as Record<string, unknown>[]) {
        if (!r.id) errors.push('cv.rule: missing id');
        if (!types.includes(r.type as string)) errors.push(`cv.rule ${r.id}: invalid type "${r.type}"`);
        if (typeof r.threshold !== 'number') errors.push(`cv.rule ${r.id}: threshold must be a number`);
        if ((r.type === 'zone_breach' || r.type === 'loitering') && !r.zoneId)
          errors.push(`cv.rule ${r.id}: ${r.type} needs zoneId`);
        if (r.type === 'line_surge' && !r.lineId) errors.push(`cv.rule ${r.id}: line_surge needs lineId`);
      }
  }
  if (cv.speed !== undefined) {
    const sp = cv.speed as Record<string, unknown>;
    if (!Array.isArray(sp.imagePoints) || sp.imagePoints.length !== 4)
      errors.push('cv.speed.imagePoints must be exactly 4 points');
    if (!Array.isArray(sp.worldPoints) || sp.worldPoints.length !== 4)
      errors.push('cv.speed.worldPoints must be exactly 4 points');
    (Array.isArray(sp.imagePoints) ? sp.imagePoints : []).forEach((p, i) => point(p, `cv.speed.imagePoints[${i}]`));
  }
  return errors;
}

const createSchema = z.object({
  kind: z.enum([
    'instagram', 'twitter', 'reddit', 'bluesky', 'tiktok',
    'webcam', 'traffic_cam', 'weather_cam', 'ip_camera',
    'rss', 'news_api', 'gdelt', 'github', 'hn', 'arxiv',
    'windy', 'youtube', 'telegram', 'discord',
    'shodan', 'censys', 'crtsh', 'virustotal', 'hibp',
    'webcrawl', 'twitter_scrape', 'reddit_scrape', 'sherlock',
    'urlscan', 'pastebin', 'gist',
    'darksearch', 'greynoise', 'stix', 'nvd',
  ]),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  config: z.record(z.unknown()),
  enabled: z.boolean().default(true),
  pollIntervalSeconds: z.number().int().min(10).max(86400).default(300),
  createdByUserId: z.string().optional(),
});

app.get('/', async (c) => {
  const sources = await listSources();
  return c.json({ sources }, 200, {
    'Cache-Control': 'public, max-age=60',
  });
});

app.get('/:id', async (c) => {
  const source = await getSource(c.req.param('id'));
  if (!source) return c.json({ error: 'Not found' }, 404);
  return c.json(source);
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const data = parsed.data;
  const adapter = getAdapter(data.kind);
  if (!adapter) {
    return c.json({ error: `Unsupported source kind: ${data.kind}` }, 400);
  }

  const validation = adapter.validate(data.config);
  if (!validation.valid) {
    return c.json({ error: 'Adapter validation failed', details: validation.errors }, 400);
  }

  const cvErrors = validateCvConfig(data.config);
  if (cvErrors.length) {
    return c.json({ error: 'CV config validation failed', details: cvErrors }, 400);
  }

  const source = await createSource({
    id: randomUUID(),
    ...data,
    config: { ...data.config, sourceId: randomUUID() },
    lastPolledAt: undefined,
    lastEventAt: undefined,
    errorCount: 0,
    lastError: undefined,
  });

  return c.json(source, 201);
});

app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) patch.name = String(body.name);
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.config !== undefined) {
    const cvErrors = validateCvConfig(body.config as Record<string, unknown>);
    if (cvErrors.length) {
      return c.json({ error: 'CV config validation failed', details: cvErrors }, 400);
    }
    patch.config = body.config;
  }
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.pollIntervalSeconds !== undefined) patch.pollIntervalSeconds = Number(body.pollIntervalSeconds);

  await updateSource(id, patch);
  const updated = await getSource(id);
  return c.json(updated);
});

app.delete('/:id', async (c) => {
  await deleteSource(c.req.param('id'));
  return c.json({ ok: true });
});

export default app;
