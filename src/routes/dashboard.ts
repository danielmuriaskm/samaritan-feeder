import { Hono } from 'hono';
import { listSources } from '../store/sources.js';
import { listEvents } from '../store/events.js';

const app = new Hono();

app.get('/', async (c) => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const [sources, eventsLastHour, eventsLastDay] = await Promise.all([
    listSources(),
    listEvents({ since: hourAgo, limit: 1000 }),
    listEvents({ since: dayAgo, limit: 1000 }),
  ]);

  const kindBreakdown = eventsLastDay.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const sourceBreakdown = eventsLastDay.reduce((acc, e) => {
    acc[e.sourceId] = (acc[e.sourceId] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return c.json({
    sources: {
      total: sources.length,
      enabled: sources.filter((s) => s.enabled).length,
      healthy: sources.filter((s) => s.errorCount < 5).length,
      byKind: sources.reduce((acc, s) => {
        acc[s.kind] = (acc[s.kind] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
    events: {
      lastHour: eventsLastHour.length,
      lastDay: eventsLastDay.length,
      kindBreakdown,
      topSources: Object.entries(sourceBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => ({ sourceId: id, count })),
    },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

app.get('/recent', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const events = await listEvents({ limit });
  return c.json({ events });
});

export default app;
