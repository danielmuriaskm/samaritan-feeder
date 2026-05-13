import { Hono } from 'hono';
import { listSources } from '../store/sources.js';
import { listEvents } from '../store/events.js';

const app = new Hono();

app.get('/', async (c) => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const sources = await listSources(true);
  const recentEvents = await listEvents({ since: hourAgo, limit: 1000 });

  return c.json({
    status: 'ok',
    sources: {
      total: sources.length,
      healthy: sources.filter((s) => s.errorCount < 5).length,
    },
    events: {
      last_hour: recentEvents.length,
    },
    uptime: process.uptime(),
  });
});

export default app;
