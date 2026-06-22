import { Hono } from 'hono';
import { getDiscoverFeed } from '../processors/discoverSynth.js';

/**
 * `/discover` — a Perplexity-Discover-style feed synthesized from ingested
 * events. samaritan-server's UI proxies `/discover`, `/discover/stats`, and
 * `/discover/sources` here, so this router is mounted at BOTH the root and under
 * `/api` (the same instance is shared by both mounts).
 *
 * All three handlers read from the in-process cache in discoverSynth, so a burst
 * of requests costs at most one bounded synthesis per TTL window — never a 500,
 * because the synth always returns a valid (possibly deterministic) feed.
 */
const app = new Hono();

/** Clamp an optional ?limit= to a sane range. */
function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// GET /discover — the tile feed.
app.get('/', async (c) => {
  const feed = await getDiscoverFeed();
  const limit = parseLimit(c.req.query('limit'), feed.tiles.length, 50);
  return c.json({ tiles: feed.tiles.slice(0, limit) });
});

// GET /discover/stats — feed metadata.
app.get('/stats', async (c) => {
  const feed = await getDiscoverFeed();
  return c.json({
    tiles: feed.tiles.length,
    eventsConsidered: feed.eventsConsidered,
    lastRefresh: feed.lastRefresh,
    model: feed.model,
  });
});

// GET /discover/sources — distinct sources feeding the current tiles.
app.get('/sources', async (c) => {
  const feed = await getDiscoverFeed();
  const map = new Map<string, { sourceId: string; kind: string; count: number; tiles: number }>();
  for (const tile of feed.tiles) {
    for (const s of tile.sources) {
      const cur = map.get(s.sourceId);
      if (cur) {
        cur.count += s.count;
        cur.tiles += 1;
      } else {
        map.set(s.sourceId, { sourceId: s.sourceId, kind: s.kind, count: s.count, tiles: 1 });
      }
    }
  }
  const sources = [...map.values()].sort((a, b) => b.count - a.count);
  return c.json({ sources });
});

export default app;
