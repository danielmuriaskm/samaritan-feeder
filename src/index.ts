import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
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
import authRoutes from './routes/auth.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: [config.SAMARITAN_BASE_URL, 'http://localhost:5173'],
  credentials: true,
}));

// Mount routes
app.route('/health', healthRoutes);
app.route('/sources', sourceRoutes);
app.route('/events', eventRoutes);
app.route('/stream', streamRoutes);
app.route('/subscriptions', subscriptionRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/library', libraryRoutes);
app.route('/auth', authRoutes);

// Digest endpoint for Samaritan system prompt injection
app.get('/digest/:userId', async (c) => {
  const queryParam = c.req.query('query') ?? '';

  const { searchEvents } = await import('./store/events.js');
  const since = Date.now() - 15 * 60 * 1000; // last 15 minutes
  const events = await searchEvents({ query: queryParam, since, limit: 10 });

  if (events.length === 0) {
    return c.json({ digest: null });
  }

  const lines = events.map((e) => {
    const time = new Date(e.eventAt).toLocaleTimeString();
    return `[${time}] ${e.title ?? e.kind}: ${e.content.slice(0, 200)}`;
  });

  return c.json({
    digest: lines.join('\\n'),
    eventCount: events.length,
    sources: [...new Set(events.map((e) => e.sourceId))],
  });
});

// Ingest endpoint (bidirectional: Samaritan can push intel back)
app.post('/ingest', async (c) => {
  const body = await c.req.json();
  return c.json({ received: true, id: body.id ?? 'pending' }, 202);
});

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Error handler
app.onError((err, c) => {
  console.error('[server] Unhandled error:', err);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

const port = parseInt(config.PORT, 10);

// Node.js HTTP server (works in Node 22, no Bun required)
const { createServer } = await import('node:http');
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.on('data', (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => req.on('end', resolve));
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });

  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(await response.text());
});

server.listen(port, () => {
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
