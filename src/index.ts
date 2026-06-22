import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from '@hono/node-server/serve-static';
import { authMiddleware } from './middleware/auth.js';
import { verifyHandshake, issueFeederSession } from './auth/feederSession.js';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { pool } from './db.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import healthRoutes from './routes/health.js';
import sourceRoutes from './routes/sources.js';
import eventRoutes from './routes/events.js';
import streamRoutes from './routes/stream.js';
import subscriptionRoutes from './routes/subscriptions.js';
import dashboardRoutes from './routes/dashboard.js';
import libraryRoutes from './routes/library.js';
import ipCameraRoutes from './routes/ipcameras.js';
import hispacamsRoutes from './routes/hispacams.js';
import windyRoutes from './routes/windy.js';
import authRoutes from './routes/auth.js';
import graphRoutes from './routes/graph.js';
import mitreRoutes from './routes/mitre.js';
import cvRoutes from './routes/cv.js';
import { listChannels, getChannel, createChannel, deleteChannel, setEnabled, isChannelKind } from './store/channels.js';
import { listSignals } from './store/signals.js';
import { latestBrief } from './store/briefs.js';
import type { SignalKind } from './types.js';

const app = new Hono();

// --- 005: signals (correlation/freshness) read route ---
const signalRoutes = new Hono();
signalRoutes.get('/', async (c) => {
  const kindsParam = c.req.query('kinds');
  const kinds = kindsParam ? (kindsParam.split(',').map((s) => s.trim()).filter(Boolean) as SignalKind[]) : undefined;
  const since = c.req.query('since') ? Number(c.req.query('since')) : undefined;
  const minScore = c.req.query('minScore') ? Number(c.req.query('minScore')) : undefined;
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  return c.json({ signals: await listSignals({ kinds, since, minScore, limit }) });
});

// --- 005: multi-channel delivery CRUD ---
const channelRoutes = new Hono();
channelRoutes.get('/', async (c) => {
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'userId required' }, 400);
  const enabledOnly = c.req.query('enabledOnly') === 'true';
  return c.json({ channels: await listChannels(userId, enabledOnly) });
});
channelRoutes.get('/:id', async (c) => {
  const ch = await getChannel(c.req.param('id'));
  return ch ? c.json(ch) : c.json({ error: 'Not found' }, 404);
});
channelRoutes.post('/', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b?.userId || !isChannelKind(b?.kind)) return c.json({ error: 'userId and valid kind required' }, 400);
  const ch = await createChannel({
    userId: String(b.userId),
    kind: b.kind,
    config: b.config && typeof b.config === 'object' ? b.config : {},
    enabled: b.enabled !== false,
    quietHours: b.quietHours,
  });
  return c.json(ch, 201);
});
channelRoutes.patch('/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b?.enabled === 'boolean') await setEnabled(c.req.param('id'), b.enabled);
  return c.json({ ok: true });
});
channelRoutes.delete('/:id', async (c) => {
  await deleteChannel(c.req.param('id'));
  return c.json({ ok: true });
});

app.use('*', logger());
app.use('*', cors({
  origin: [config.SAMARITAN_BASE_URL, 'http://localhost:5173'],
  credentials: true,
}));
// Access control: console Basic auth + Samaritan service token. `/health` is public.
// Pair with Fly-private networking (no public IP) for defense in depth.
app.use('*', authMiddleware);

// Mount routes
app.route('/health', healthRoutes);
app.route('/sources', sourceRoutes);
app.route('/events', eventRoutes);
app.route('/stream', streamRoutes);
app.route('/subscriptions', subscriptionRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/library', libraryRoutes);
app.route('/ipcameras', ipCameraRoutes);
app.route('/hispacams', hispacamsRoutes);
app.route('/windy', windyRoutes);
app.route('/auth', authRoutes);
app.route('/graph', graphRoutes);
app.route('/mitre', mitreRoutes);
app.route('/cv', cvRoutes);
app.route('/signals', signalRoutes);
app.route('/channels', channelRoutes);

// API prefix for web UI (Vite dev proxy uses /api)
const api = new Hono();
api.route('/health', healthRoutes);
api.route('/sources', sourceRoutes);
api.route('/events', eventRoutes);
api.route('/stream', streamRoutes);
api.route('/subscriptions', subscriptionRoutes);
api.route('/dashboard', dashboardRoutes);
api.route('/library', libraryRoutes);
api.route('/ipcameras', ipCameraRoutes);
api.route('/hispacams', hispacamsRoutes);
api.route('/windy', windyRoutes);
api.route('/auth', authRoutes);
api.route('/graph', graphRoutes);
api.route('/mitre', mitreRoutes);
api.route('/cv', cvRoutes);
api.route('/signals', signalRoutes);
api.route('/channels', channelRoutes);
// Brief + digest, shared between /api (the web console fetches /api/brief/:userId)
// and the root (Samaritan system-prompt injection).
async function briefHandler(c: Context) {
  const userId = c.req.param('userId');
  const brief = (await latestBrief(userId)) ?? (await latestBrief(undefined));
  return c.json({ brief: brief ?? null });
}
async function digestHandler(c: Context) {
  const queryParam = c.req.query('query') ?? '';
  const { searchEvents } = await import('./store/events.js');
  const since = Date.now() - 15 * 60 * 1000; // last 15 minutes
  const events = await searchEvents({ query: queryParam, since, limit: 10 });
  if (events.length === 0) return c.json({ digest: null });
  const lines = events.map((e) => {
    const time = new Date(e.eventAt).toLocaleTimeString();
    return `[${time}] ${e.title ?? e.kind}: ${e.content.slice(0, 200)}`;
  });
  return c.json({
    digest: lines.join('\n'),
    eventCount: events.length,
    sources: [...new Set(events.map((e) => e.sourceId))],
  });
}
api.get('/brief/:userId', briefHandler);
api.get('/digest/:userId', digestHandler);
app.route('/api', api);

app.get('/brief/:userId', briefHandler);
app.get('/digest/:userId', digestHandler);

// Ingest endpoint (bidirectional: Samaritan can push intel back)
app.post('/ingest', async (c) => {
  const body = await c.req.json();
  return c.json({ received: true, id: body.id ?? 'pending' }, 202);
});

// SSO handshake landing. Samaritan's /auth/sso redirects here with a short-lived token
// (aud 'feeder-sso', signed with the shared secret). Verify it, set this origin's own
// session cookie, then bounce to the console — so a Samaritan-logged-in user never sees
// the feeder's own login. (Exempted from the auth middleware in middleware/auth.ts.)
app.get('/auth/sso/callback', async (c) => {
  const session = await verifyHandshake(c.req.query('token') ?? '');
  if (!session) {
    return c.html('<p>SSO failed: invalid or expired token. Log into Samaritan, then retry.</p>', 401);
  }
  await issueFeederSession(c, { uid: session.uid, email: session.email });
  return c.redirect('/', 302);
});

// Static files + SPA fallback — registered LAST so the catch-all wildcard does not
// shadow the API / brief / digest GET routes above.
app.use('/*', serveStatic({ root: './web/dist' }));
app.get('*', (c) => {
  try {
    const html = readFileSync('./web/dist/index.html', 'utf-8');
    return c.html(html);
  } catch {
    return c.json({ error: 'Web UI not built. Run npm run build in web/' }, 503);
  }
});

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Error handler
app.onError((err, c) => {
  console.error('[server] Unhandled error:', err);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

const port = parseInt(config.PORT, 10);

// @hono/node-server streams responses correctly — including SSE / text/event-stream.
// The previous hand-rolled server did `res.end(await response.text())`, which
// buffers the entire body and therefore can NEVER flush an open event stream
// (that's why the Live tab showed "disconnected").
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[feeder] Server listening on port ${port}`);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`[feeder] ${signal} received. Shutting down...`);
  stopScheduler();
  server.close(() => console.log('[feeder] HTTP server closed'));
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Bootstrap
startScheduler();
console.log('[feeder] Intelligence feeder started');
