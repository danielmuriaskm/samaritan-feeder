import { Hono } from 'hono';
import { z } from 'zod';
import {
  listEvents,
  searchEvents,
  listTopEvents,
  getEvent,
  eventToExportRow,
  EVENT_EXPORT_COLUMNS,
} from '../store/events.js';
import { toCsv, toNdjson } from '../lib/exporters.js';
import type { EventKind, DataClass, RiskBand } from '../types.js';

const app = new Hono();

const DATA_CLASSES = [
  'hazard_alert', 'cyber_ioc', 'vulnerability', 'breach_leak', 'leaked_secret',
  'exposed_service', 'malware', 'phishing', 'defacement', 'recon_finding',
  'cv_detection', 'social_post', 'news', 'research', 'other',
] as const;
const RISK_BANDS = ['INFO', 'LOW', 'MEDIUM', 'HIGH'] as const;

const querySchema = z.object({
  query: z.string().optional(),
  sourceId: z.string().optional(),
  kinds: z.string().optional(), // comma-separated
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  // 005: rank by composite importance score ("most important first") instead of recency.
  rank: z.enum(['recency', 'score']).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
  // 006: second classification axis + discrete band triage filters.
  dataClass: z.enum(DATA_CLASSES).optional(),
  riskBand: z.enum(RISK_BANDS).optional(),
  // 006: search-mode passthrough. The store's parseQueryMode owns the affix
  // grammar (*term*, /regex/); `mode` lets a caller pick a mode without the
  // affixes — we translate it into that grammar before handing off.
  mode: z.enum(['contains', 'wildcard', 'regex']).optional(),
  // 006: streaming export of the list result. Absent => unchanged JSON.
  format: z.enum(['csv', 'ndjson']).optional(),
});

/** Wrap a bare query in the store's affix grammar for an explicit `mode`. If the
 *  query already carries affixes we leave it alone so an explicit mode never
 *  double-wraps. */
function applyMode(query: string, mode?: 'contains' | 'wildcard' | 'regex'): string {
  if (!mode || mode === 'contains') return query;
  const wrapped = mode === 'wildcard' ? /^\*.*\*$/.test(query) : /^\/.*\/$/.test(query);
  if (wrapped) return query;
  return mode === 'wildcard' ? `*${query}*` : `/${query}/`;
}

app.get('/', async (c) => {
  const params = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!params.success) {
    return c.json({ error: 'Invalid query params', issues: params.error.issues }, 400);
  }

  const p = params.data;
  const kinds = p.kinds ? (p.kinds.split(',') as EventKind[]) : undefined;
  const dataClass = p.dataClass as DataClass | undefined;
  const riskBand = p.riskBand as RiskBand | undefined;

  let events;
  if (p.query) {
    events = await searchEvents({
      query: applyMode(p.query, p.mode),
      sourceId: p.sourceId,
      kinds,
      since: p.since,
      until: p.until,
      dataClass,
      riskBand,
      minScore: p.minScore,
      limit: p.limit,
    });
  } else if (p.rank === 'score') {
    // Ranked ("most important first") read path — composite score desc.
    events = await listTopEvents({
      sourceId: p.sourceId,
      kinds,
      since: p.since,
      minScore: p.minScore,
      dataClass,
      riskBand,
      limit: p.limit,
    });
  } else {
    events = await listEvents({
      sourceId: p.sourceId,
      kinds,
      since: p.since,
      until: p.until,
      limit: p.limit,
      offset: p.offset,
    });
  }

  if (p.format === 'csv') {
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="events.csv"');
    return c.body(toCsv(events.map(eventToExportRow), EVENT_EXPORT_COLUMNS));
  }
  if (p.format === 'ndjson') {
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="events.ndjson"');
    return c.body(toNdjson(events.map(eventToExportRow)));
  }

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
