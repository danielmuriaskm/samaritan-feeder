import { Hono } from 'hono';
import { listSources } from '../store/sources.js';
import { listEvents, searchEvents } from '../store/events.js';
import { riskMatrix, RISK_BAND_ORDER } from '../scoring/severity.js';
import { query, one } from '../db.js';

const app = new Hono();

app.get('/', async (c) => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const [sources, eventsLastHour, eventsLastDay, eventsLastWeek] = await Promise.all([
    listSources(),
    listEvents({ since: hourAgo, limit: 1000 }),
    listEvents({ since: dayAgo, limit: 1000 }),
    listEvents({ since: weekAgo, limit: 5000 }),
  ]);

  const kindBreakdown = eventsLastDay.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Risk matrix: how many of the last-24h events fall in each derived risk band
  // (HIGH/MEDIUM/LOW/INFO). Reuses the already-fetched eventsLastDay set — no extra
  // query — and bands them via the shared deriveRiskBand thresholds. Falls back to
  // `confidence` for rows not yet composite-scored, matching the read path's COALESCE.
  const riskMatrixCounts = riskMatrix(eventsLastDay.map((e) => e.score ?? e.confidence));
  const riskMatrixBands = RISK_BAND_ORDER.map((band) => ({ band, count: riskMatrixCounts[band] }));

  const sourceBreakdown = eventsLastDay.reduce((acc, e) => {
    acc[e.sourceId] = (acc[e.sourceId] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Timeline: events per hour for last 24h
  const timeline: Record<string, number> = {};
  for (let i = 0; i < 24; i++) {
    const h = new Date(Date.now() - i * 60 * 60 * 1000);
    const key = `${h.getHours().toString().padStart(2, '0')}:00`;
    timeline[key] = 0;
  }
  for (const e of eventsLastDay) {
    const h = new Date(e.createdAt);
    const key = `${h.getHours().toString().padStart(2, '0')}:00`;
    if (timeline[key] !== undefined) timeline[key]++;
  }
  // Reverse to chronological order
  const timelineOrdered = Object.entries(timeline).reverse();

  // Source health breakdown
  const sourceHealth = {
    healthy: sources.filter((s) => s.enabled && s.errorCount === 0).length,
    warning: sources.filter((s) => s.enabled && s.errorCount > 0 && s.errorCount < 5).length,
    critical: sources.filter((s) => s.enabled && s.errorCount >= 5).length,
    disabled: sources.filter((s) => !s.enabled).length,
  };

  // Entity stats
  const entityCount = await one<{ count: string }>(`SELECT COUNT(*) as count FROM intelligence_entities`);
  const entityTypeBreakdown = await query<{ type: string; count: string }>(
    `SELECT type, COUNT(*) as count FROM intelligence_entities GROUP BY type ORDER BY count DESC`,
  );
  const topEntities = await query<{ id: string; type: string; value: string; event_count: string }>(
    `SELECT id, type, value, event_count FROM intelligence_entities ORDER BY event_count DESC LIMIT 10`,
  );

  // MITRE stats
  const mitreEvents = await searchEvents({ limit: 1000 });
  const techniqueCounts: Record<string, { name: string; count: number }> = {};
  for (const ev of mitreEvents) {
    const techs = ev.tags.mitre_techniques;
    if (Array.isArray(techs)) {
      for (const t of techs) {
        const id = typeof t === 'string' ? t : (t.id as string);
        const name = typeof t === 'string' ? t : (t.name as string) || id;
        if (!techniqueCounts[id]) techniqueCounts[id] = { name, count: 0 };
        techniqueCounts[id].count++;
      }
    }
  }

  return c.json({
    sources: {
      total: sources.length,
      enabled: sources.filter((s) => s.enabled).length,
      healthy: sources.filter((s) => s.errorCount < 5).length,
      byKind: sources.reduce((acc, s) => {
        acc[s.kind] = (acc[s.kind] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      health: sourceHealth,
    },
    events: {
      lastHour: eventsLastHour.length,
      lastDay: eventsLastDay.length,
      lastWeek: eventsLastWeek.length,
      kindBreakdown,
      riskMatrix: {
        window: 'lastDay',
        counts: riskMatrixCounts,
        bands: riskMatrixBands,
      },
      topSources: Object.entries(sourceBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, count]) => ({ sourceId: id, count })),
      timeline: timelineOrdered,
    },
    entities: {
      total: Number(entityCount?.count ?? 0),
      byType: entityTypeBreakdown.map((r) => ({ type: r.type, count: Number(r.count) })),
      top: topEntities.map((r) => ({ id: r.id, type: r.type, value: r.value, count: Number(r.event_count) })),
    },
    mitre: {
      topTechniques: Object.entries(techniqueCounts)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([id, data]) => ({ id, name: data.name, count: data.count })),
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
