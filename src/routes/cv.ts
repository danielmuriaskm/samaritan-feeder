import { Hono } from 'hono';
import { config } from '../config.js';
import { renderGo2rtcConfig } from '../cv/go2rtcConfig.js';
import { recentZoneCounts, recentAlerts, searchAlertsByText, SemanticSearchUnavailable } from '../store/cv.js';
import { embedText, CvSidecarError } from '../processors/detection.js';

const app = new Hono();

/** CV sidecar reachability + model status (proxies the sidecar /health). */
app.get('/health', async (c) => {
  if (!config.CV_ENABLED || !config.CV_SIDECAR_URL) {
    return c.json({ enabled: false });
  }
  try {
    const res = await fetch(`${config.CV_SIDECAR_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return c.json({ enabled: true, reachable: res.ok, sidecar: body });
  } catch (err) {
    return c.json({ enabled: true, reachable: false, error: err instanceof Error ? err.message : String(err) }, 200);
  }
});

/** Generated go2rtc stream map (optional normalization layer). */
app.get('/go2rtc.yaml', async (c) => {
  const yaml = await renderGo2rtcConfig();
  return c.text(yaml, 200, { 'Content-Type': 'text/yaml; charset=utf-8' });
});

/** Recent zone/line counts for a source (dashboard / trend queries). */
app.get('/detail/:sourceId', async (c) => {
  const sinceHours = Number(c.req.query('hours') ?? 24);
  const since = Date.now() - sinceHours * 60 * 60 * 1000;
  const rows = await recentZoneCounts(c.req.param('sourceId'), since);
  return c.json({ counts: rows });
});

/** Recent alert firings for a source. */
app.get('/alerts/:sourceId', async (c) => {
  const sinceHours = Number(c.req.query('hours') ?? 24);
  const since = Date.now() - sinceHours * 60 * 60 * 1000;
  const rows = await recentAlerts(c.req.param('sourceId'), since);
  return c.json({ alerts: rows });
});

/** Semantic search over de-identified alert frames (text -> nearest frames). */
app.get('/search', async (c) => {
  if (!config.CV_SEMANTIC_SEARCH) {
    return c.json({ error: 'Semantic search disabled (set CV_SEMANTIC_SEARCH=true and run the optional migration)' }, 400);
  }
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'missing query param ?q=' }, 400);
  const limit = Math.min(100, Number(c.req.query('limit') ?? 20));
  try {
    const vec = await embedText(q);
    const results = await searchAlertsByText(vec, limit);
    return c.json({ query: q, results });
  } catch (err) {
    if (err instanceof SemanticSearchUnavailable) return c.json({ error: err.message }, 503);
    if (err instanceof CvSidecarError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;
