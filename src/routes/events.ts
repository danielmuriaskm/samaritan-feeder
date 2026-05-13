import { Hono } from 'hono';
import { z } from 'zod';
import { listEvents, searchEvents, getEvent } from '../store/events.js';

const app = new Hono();

const querySchema = z.object({
  query: z.string().optional(),
  sourceId: z.string().optional(),
  kinds: z.string().optional(), // comma-separated
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get('/', async (c) => {
  const params = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!params.success) {
    return c.json({ error: 'Invalid query params', issues: params.error.issues }, 400);
  }

  const p = params.data;
  const kinds = p.kinds ? p.kinds.split(',') as ('visual' | 'text' | 'anomaly' | 'trend' | 'alert' | 'social_post')[] : undefined;

  if (p.query) {
    const events = await searchEvents({
      query: p.query,
      kinds,
      since: p.since,
      limit: p.limit,
    });
    return c.json({ events });
  }

  const events = await listEvents({
    sourceId: p.sourceId,
    kinds,
    since: p.since,
    until: p.until,
    limit: p.limit,
    offset: p.offset,
  });

  return c.json({ events });
});

app.get('/:id', async (c) => {
  const event = await getEvent(c.req.param('id'));
  if (!event) return c.json({ error: 'Not found' }, 404);
  return c.json(event);
});

// Internal webhook for adapters to push events directly
app.post('/', async (c) => {
  const body = await c.req.json();
  // In a real implementation, this would validate and queue the event
  // for background processing rather than blocking the request.
  return c.json({ queued: true, id: body.id ?? 'pending' }, 202);
});

export default app;
