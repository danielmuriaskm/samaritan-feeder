import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { listSources, getSource, createSource, updateSource, deleteSource } from '../store/sources.js';
import { getAdapter } from '../adapters/index.js';

const app = new Hono();

const createSchema = z.object({
  kind: z.enum([
    'instagram', 'twitter', 'reddit', 'bluesky', 'tiktok',
    'webcam', 'traffic_cam', 'weather_cam', 'ip_camera',
    'rss', 'news_api', 'gdelt', 'github', 'hn', 'arxiv',
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
  return c.json({ sources });
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
  if (body.config !== undefined) patch.config = body.config;
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
