import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';
import type { MakeEvent } from './usgs.js';

/**
 * NASA EONET (Earth Observatory Natural Event Tracker) v3 adapter.
 *
 * Clean-room: borrows only the *concept* of consuming the public EONET events
 * API from worldmonitor. The endpoint, JSON shape, and field names are facts
 * documented by NASA (https://eonet.gsfc.nasa.gov/docs/v3). No upstream code or
 * strings are reused.
 *
 * EONET groups natural events (wildfires, storms, volcanoes, ice, floods...) by
 * category, each with one-or-more dated geometry points. We emit one event per
 * EONET event, located at its most recent geometry.
 */

const API_BASE = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const MAX_EVENTS = 50;

interface EonetGeometry {
  date?: string; // ISO-8601
  type?: string; // 'Point' | 'Polygon'
  // Point: [lon, lat]; Polygon: nested arrays.
  coordinates?: unknown;
}

interface EonetCategory {
  id?: string;
  title?: string;
}

interface EonetEvent {
  id?: string;
  title?: string;
  description?: string | null;
  link?: string;
  closed?: string | null; // ISO date when event ended, or null if ongoing
  categories?: EonetCategory[];
  sources?: Array<{ id?: string; url?: string }>;
  geometry?: EonetGeometry[];
}

interface EonetPayload {
  events?: EonetEvent[];
}

/** Pull a [lon, lat] pair from a Point geometry (ignores polygons for location). */
function pointLatLon(geom: EonetGeometry | undefined): { lat: number; lon: number } | undefined {
  if (!geom || !Array.isArray(geom.coordinates)) return undefined;
  const c = geom.coordinates as unknown[];
  const lon = typeof c[0] === 'number' ? c[0] : undefined;
  const lat = typeof c[1] === 'number' ? c[1] : undefined;
  if (lat === undefined || lon === undefined) return undefined;
  return { lat, lon };
}

function parseIso(input: string | null | undefined): number | undefined {
  if (typeof input !== 'string') return undefined;
  const ts = Date.parse(input);
  return Number.isNaN(ts) ? undefined : ts;
}

/**
 * Pure parser: EONET payload -> RawEvent[]. Exported so it can be unit-tested
 * with a fixture and no network. Ongoing (un-"closed") events get slightly
 * higher confidence than ones the tracker has already closed.
 */
export function parseEonet(
  payload: EonetPayload,
  opts: { sourceId: string; category?: string; max?: number; makeEvent: MakeEvent },
): RawEvent[] {
  const { sourceId, category, makeEvent } = opts;
  const max = opts.max ?? MAX_EVENTS;
  const list = Array.isArray(payload.events) ? payload.events : [];
  const events: RawEvent[] = [];

  for (const ev of list) {
    if (events.length >= max) break;

    const cats = Array.isArray(ev.categories) ? ev.categories : [];
    const catTitles = cats.map((c) => c.title).filter((t): t is string => typeof t === 'string');
    const catIds = cats.map((c) => c.id).filter((t): t is string => typeof t === 'string');

    // Optional client-side category filter (EONET also supports a server param,
    // but filtering here keeps the parser self-contained and testable).
    if (category && !catIds.includes(category) && !catTitles.some((t) => t.toLowerCase() === category.toLowerCase())) {
      continue;
    }

    const geoms = Array.isArray(ev.geometry) ? ev.geometry : [];
    const last = geoms[geoms.length - 1];
    const location = pointLatLon(last);
    const eventAt = parseIso(last?.date) ?? parseIso(ev.closed) ?? Date.now();
    const ongoing = !ev.closed;
    const link = ev.link ?? ev.sources?.[0]?.url;

    const contentLines = [
      ev.title ?? 'Natural event',
      catTitles.length ? `Category: ${catTitles.join(', ')}` : '',
      ongoing ? 'Status: ongoing' : `Status: closed ${ev.closed}`,
      ev.description ? String(ev.description) : '',
      link ? `Details: ${link}` : '',
    ].filter(Boolean);

    events.push(
      makeEvent(
        {
          kind: 'anomaly',
          title: ev.title ?? `EONET ${catTitles[0] ?? 'event'}`,
          content: contentLines.join('\n'),
          eventAt,
          confidence: ongoing ? 0.8 : 0.65,
          location,
          dedupeContent: ev.id ? `eonet:${ev.id}` : undefined,
          tags: {
            eonet_id: ev.id,
            categories: catTitles,
            category_ids: catIds,
            ongoing,
            closed: ev.closed ?? undefined,
            url: link,
          },
          rawData: ev as Record<string, unknown>,
        },
        sourceId,
      ),
    );
  }

  return events;
}

export class EonetAdapter extends BaseAdapter {
  readonly kind = 'eonet' as const;
  readonly name = 'NASA EONET Natural Events';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.category !== undefined && typeof config.category !== 'string') {
      errors.push('category must be a string (e.g. "wildfires" or "8")');
    }
    if (config.limit !== undefined && typeof config.limit !== 'number') {
      errors.push('limit must be a number');
    }
    if (config.status !== undefined && !['open', 'closed', 'all'].includes(String(config.status))) {
      errors.push('status must be one of open, closed, all');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const category = typeof config.category === 'string' ? config.category : undefined;
    const status = ['open', 'closed', 'all'].includes(String(config.status)) ? String(config.status) : 'open';
    const limit = typeof config.limit === 'number' ? Math.min(config.limit, MAX_EVENTS) : MAX_EVENTS;
    const sourceId = String(config.sourceId ?? 'eonet');

    const url = new URL(API_BASE);
    url.searchParams.set('status', status);
    url.searchParams.set('limit', String(limit));

    const res = await safeFetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`EONET fetch failed: ${res.status} ${res.statusText}`);
    }

    const payload = (await res.json()) as EonetPayload;
    return parseEonet(payload, { sourceId, category, max: limit, makeEvent: this.makeEvent.bind(this) });
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(`${API_BASE}?limit=1&status=open`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
