import { Hono } from 'hono';
import { getDiscoverFeed } from '../processors/discoverSynth.js';
import { listEvents, listEventsDeduped, searchEvents } from '../store/events.js';
import { listSources } from '../store/sources.js';
import { query } from '../db.js';
import type { EventKind, IntelligenceEvent } from '../types.js';

/**
 * `/discover` — the intelligence feed consumed by samaritan-server's web app
 * (apps/web DiscoverPage.tsx + the miniapp Today feed), proxied here.
 *
 * RESPONSE CONTRACT (must match the SPA, which reads `data.events`):
 *   GET /discover          -> { events: IntelEvent[], count, tiles }
 *   GET /discover/stats     -> { total, byKind, bySourceKind, sources, enabledSources, ...tileStats }
 *   GET /discover/sources   -> { sources: SourceConfig[] }
 *
 * The `tiles` / tile-stats fields are kept as a SUPERSET so the feeder's own web
 * console (web/DiscoverPanel.tsx, which reads `.tiles` and the tile stats) keeps
 * working off the same endpoints. The Perplexity-style tile feed still comes from
 * discoverSynth's bounded, cached, fail-soft synthesis.
 */
const app = new Hono();

const KIND_VALUES: EventKind[] = ['visual', 'text', 'anomaly', 'trend', 'alert', 'social_post', 'detection'];

/** Parse a CSV `kinds=` filter down to the known EventKind set. */
function parseKinds(raw: string | undefined): EventKind[] | undefined {
  if (!raw) return undefined;
  const set = raw
    .split(',')
    .map((s) => s.trim())
    .filter((k): k is EventKind => (KIND_VALUES as string[]).includes(k));
  return set.length ? set : undefined;
}

/** Clamp `limit` to [1, max]. */
function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Strip the heavy/internal columns (embedding/vectorV/rawData/…) and project to
 * the lean shape the SPA's IntelEvent expects. */
function toClientEvent(e: IntelligenceEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: e.id,
    sourceId: e.sourceId,
    kind: e.kind,
    title: e.title ?? null,
    content: e.content,
    confidence: e.confidence,
    tags: e.tags ?? {},
    eventAt: e.eventAt,
    createdAt: e.createdAt,
  };
  if (e.score != null) out.score = e.score;
  if (e.location) out.location = e.location;
  return out;
}

// GET /discover — the intelligence event feed (+ tiles superset for the console).
app.get('/', async (c) => {
  const q = c.req.query('q')?.trim() || undefined;
  const sourceId = c.req.query('source_id') || c.req.query('sourceId') || undefined;
  const kinds = parseKinds(c.req.query('kinds'));
  const sinceHours = parseFloat(c.req.query('since_hours') ?? '');
  const limit = clampLimit(c.req.query('limit'), 150, 500);
  const since = Number.isFinite(sinceHours) && sinceHours > 0 ? Date.now() - sinceHours * 3_600_000 : undefined;

  let events: IntelligenceEvent[] = [];
  try {
    events = q
      ? await searchEvents({ query: q, sourceId, kinds, since, limit })
      : await listEvents({ sourceId, kinds, since, limit });
  } catch {
    events = [];
  }

  // Tiles preserved for the feeder console; bounded + fail-soft.
  let tiles: unknown[] = [];
  try {
    const feed = await getDiscoverFeed();
    tiles = feed.tiles.slice(0, Math.min(limit, 50));
  } catch {
    tiles = [];
  }

  const clientEvents = events.map(toClientEvent);
  return c.json({ events: clientEvents, count: clientEvents.length, tiles });
});

// GET /discover/stats — event/source rollup (+ tile stats superset).
app.get('/stats', async (c) => {
  let total = 0;
  const byKind: Record<string, number> = {};
  const bySourceKind: Record<string, number> = {};
  let sources = 0;
  let enabledSources = 0;
  try {
    const totRows = await query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM intelligence_events`);
    total = Number(totRows[0]?.n ?? 0);
    const kindRows = await query<{ kind: string; n: string }>(
      `SELECT kind, COUNT(*)::int AS n FROM intelligence_events GROUP BY kind`,
    );
    for (const r of kindRows) byKind[r.kind] = Number(r.n);
    const skRows = await query<{ kind: string; n: string }>(
      `SELECT s.kind, COUNT(e.*)::int AS n
         FROM intelligence_events e JOIN intelligence_sources s ON s.id = e.source_id
        GROUP BY s.kind`,
    );
    for (const r of skRows) bySourceKind[r.kind] = Number(r.n);
    const srcRows = await query<{ total: string; enabled: string }>(
      `SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE enabled))::int AS enabled FROM intelligence_sources`,
    );
    sources = Number(srcRows[0]?.total ?? 0);
    enabledSources = Number(srcRows[0]?.enabled ?? 0);
  } catch {
    // fail-soft: a degraded DB still returns a valid (zeroed) stats envelope.
  }

  let tileStats: { tiles: number; eventsConsidered: number; lastRefresh: number; model?: string } = {
    tiles: 0,
    eventsConsidered: 0,
    lastRefresh: 0,
  };
  try {
    const feed = await getDiscoverFeed();
    tileStats = {
      tiles: feed.tiles.length,
      eventsConsidered: feed.eventsConsidered,
      lastRefresh: feed.lastRefresh,
      model: feed.model,
    };
  } catch {
    /* keep the zeroed tileStats */
  }

  return c.json({ total, byKind, bySourceKind, sources, enabledSources, ...tileStats });
});

// GET /discover/sources — the registered intelligence sources (SPA source rail).
app.get('/sources', async (c) => {
  try {
    return c.json({ sources: await listSources() });
  } catch {
    return c.json({ sources: [] });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Two-feed split (2026-06-23): the web app renders TWO distinct surfaces —
//   • Discover  = NEWS  → GET /discover/tiles  (Perplexity-style synthesized tiles)
//   • Events    = feed  → GET /discover/events (raw events/alerts, DEDUPED by title)
// `/discover` (above) stays a back-compat superset so older clients + the feeder's
// own console keep working. Both new paths live under /discover/* so samaritan-
// server's feeder proxy forwards them unchanged.
// ───────────────────────────────────────────────────────────────────────────

// GET /discover/tiles — the NEWS feed (synthesized, news-kind events only).
app.get('/tiles', async (c) => {
  const limit = clampLimit(c.req.query('limit'), 50, 50);
  try {
    const feed = await getDiscoverFeed();
    return c.json({
      tiles: feed.tiles.slice(0, limit),
      eventsConsidered: feed.eventsConsidered,
      lastRefresh: feed.lastRefresh,
      model: feed.model,
    });
  } catch {
    return c.json({ tiles: [], eventsConsidered: 0, lastRefresh: 0, model: '' });
  }
});

// GET /discover/events — the Events feed (events/alerts), DEDUPED by title so an
// over-producing source can't flood it. Same filters as the SPA's feed UI.
app.get('/events', async (c) => {
  const q = c.req.query('q')?.trim() || undefined;
  const sourceId = c.req.query('source_id') || c.req.query('sourceId') || undefined;
  const kinds = parseKinds(c.req.query('kinds'));
  const sinceHours = parseFloat(c.req.query('since_hours') ?? '');
  const limit = clampLimit(c.req.query('limit'), 150, 500);
  const since = Number.isFinite(sinceHours) && sinceHours > 0 ? Date.now() - sinceHours * 3_600_000 : undefined;

  let events: IntelligenceEvent[] = [];
  try {
    events = await listEventsDeduped({ query: q, sourceId, kinds, since, limit });
  } catch {
    events = [];
  }
  const clientEvents = events.map(toClientEvent);
  return c.json({ events: clientEvents, count: clientEvents.length });
});

export default app;
