import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { listSubscriptions, getSubscription, createSubscription, deleteSubscription } from '../store/subscriptions.js';

const app = new Hono();

const createSchema = z.object({
  userId: z.string().min(1),
  sourceId: z.string().min(1),
  filterQuery: z.string().optional(),
  minConfidence: z.number().min(0).max(1).default(0.6),
  allowedKinds: z.array(z.enum(['visual', 'text', 'anomaly', 'trend', 'alert', 'social_post'])).optional(),
  deliveryMode: z.enum(['passive', 'proactive', 'alert']).default('passive'),
  digestCron: z.string().optional(),
});

app.get('/', async (c) => {
  const userId = c.req.query('userId');
  const sourceId = c.req.query('sourceId');
  const deliveryMode = c.req.query('deliveryMode') as 'passive' | 'proactive' | 'alert' | undefined;
  const subs = await listSubscriptions({ userId: userId ?? undefined, sourceId: sourceId ?? undefined, deliveryMode });
  return c.json({ subscriptions: subs });
});

app.get('/:id', async (c) => {
  const sub = await getSubscription(c.req.param('id'));
  if (!sub) return c.json({ error: 'Not found' }, 404);
  return c.json(sub);
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', issues: parsed.error.issues }, 400);
  }

  const sub = await createSubscription({
    id: randomUUID(),
    ...parsed.data,
    lastDeliveredAt: undefined,
  });

  return c.json(sub, 201);
});

app.delete('/:id', async (c) => {
  await deleteSubscription(c.req.param('id'));
  return c.json({ ok: true });
});

export default app;
