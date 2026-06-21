import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * ReliefWeb API (UN OCHA) — humanitarian disasters & situation reports.
 * Endpoints: https://api.reliefweb.int/v1/disasters and /v1/reports.
 * The API requires an `appname` query param; we send a stable identifier.
 * Emits kind:'text' events with country/location and disaster-type tags.
 *
 * Clean-room: surfacing ReliefWeb disasters/reports as humanitarian signals is
 * inspired by worldmonitor; the request shape, field selection, primary-country
 * geocoding, and confidence heuristics here are derived from ReliefWeb's own
 * documented v1 schema and are original.
 */

const API_BASE = 'https://api.reliefweb.int/v1';
const APPNAME = 'samaritan-feeder';
const DEFAULT_CAP = 40;
const MAX_CAP = 100;

export type ReliefwebFeed = 'disasters' | 'reports';

/** Normalized ReliefWeb item emitted by the parser. */
export interface ParsedReliefItem {
  /** Stable upstream id for dedupe. */
  upstreamId: string;
  feed: ReliefwebFeed;
  title: string;
  summary: string;
  url?: string;
  country?: string;
  disasterType?: string;
  sources?: string[];
  status?: string;
  /** epoch ms */
  eventAt: number;
  location?: { lat: number; lon: number };
  confidence: number;
}

interface ReliefwebFields {
  name?: string;
  title?: string;
  status?: string;
  url?: string;
  url_alias?: string;
  date?: { created?: string; changed?: string; original?: string };
  body?: string;
  'body-html'?: string;
  primary_country?: { name?: string; location?: { lat?: number; lon?: number } };
  country?: Array<{ name?: string; primary?: boolean; location?: { lat?: number; lon?: number } }>;
  type?: Array<{ name?: string }> | { name?: string };
  source?: Array<{ name?: string; shortname?: string }>;
}

interface ReliefwebHit {
  id?: string | number;
  fields?: ReliefwebFields;
}

export class ReliefWebAdapter extends BaseAdapter {
  readonly kind = 'reliefweb' as const;
  readonly name = 'ReliefWeb (UN OCHA disasters/reports)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.feed !== undefined && config.feed !== 'disasters' && config.feed !== 'reports') {
      errors.push("config.feed must be 'disasters' or 'reports' when set");
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    if (config.query !== undefined && typeof config.query !== 'string') {
      errors.push('config.query must be a string');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const feed: ReliefwebFeed = config.feed === 'reports' ? 'reports' : 'disasters';
    const cap = clampCap(config.maxItems);
    const sourceId = slugify(String(config.sourceId ?? `reliefweb_${feed}`));
    const since = cursor ? Number(cursor) : 0;
    const query = typeof config.query === 'string' ? config.query.trim() : '';

    const url = buildRequestUrl(feed, cap, query);

    let payload: unknown;
    try {
      const res = await safeFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'samaritan-feeder' },
        timeoutMs: 20000,
      });
      if (!res.ok) throw new Error(`ReliefWeb fetch failed: ${res.status}`);
      payload = await res.json();
    } catch (err) {
      console.error('[reliefweb] Poll failed:', err instanceof Error ? err.message : String(err));
      return [];
    }

    const items = parseReliefweb(payload, feed).filter((i) => i.eventAt > since).slice(0, cap);

    return items.map((item) =>
      this.makeEvent(
        {
          kind: 'text',
          title: item.title,
          content: buildContent(item),
          eventAt: item.eventAt,
          confidence: item.confidence,
          location: item.location,
          dedupeContent: `reliefweb:${feed}:${item.upstreamId}`,
          tags: {
            feed,
            country: item.country,
            disaster_type: item.disasterType,
            status: item.status,
            sources: item.sources,
            url: item.url,
          },
        },
        sourceId,
      ),
    );
  }

  async health(_config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(`${API_BASE}/disasters?appname=${APPNAME}&limit=1`, {
        headers: { Accept: 'application/json' },
        timeoutMs: 10000,
        maxBodyBytes: 1024 * 1024,
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}

// ---------------------------------------------------------------------------
// Request building + pure parsing (parser is unit-tested)
// ---------------------------------------------------------------------------

/** Build a GET URL with appname + the field selection we want back. */
export function buildRequestUrl(feed: ReliefwebFeed, cap: number, query: string): string {
  const params = new URLSearchParams();
  params.set('appname', APPNAME);
  params.set('limit', String(cap));
  params.set('sort[]', 'date:desc');
  params.set('profile', 'full');
  if (query) params.set('query[value]', query);
  return `${API_BASE}/${feed}?${params.toString()}`;
}

/** Parse a ReliefWeb v1 response envelope into normalized items. */
export function parseReliefweb(payload: unknown, feed: ReliefwebFeed): ParsedReliefItem[] {
  const root = payload as { data?: unknown } | null;
  if (!root || !Array.isArray(root.data)) return [];
  const out: ParsedReliefItem[] = [];
  for (const raw of root.data as ReliefwebHit[]) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw.fields ?? {};
    const title = (f.name ?? f.title ?? '').toString().trim();
    if (!title) continue;
    const upstreamId = String(raw.id ?? title);
    const country = pickPrimaryCountry(f);
    const disasterType = pickType(f.type);
    out.push({
      upstreamId,
      feed,
      title,
      summary: summarize(f),
      url: f.url_alias ?? f.url,
      country: country?.name,
      disasterType,
      sources: pickSources(f.source),
      status: f.status,
      eventAt: pickDate(f.date),
      location: country?.location,
      confidence: relevanceConfidence(f, disasterType),
    });
  }
  return out;
}

function pickPrimaryCountry(f: ReliefwebFields): { name?: string; location?: { lat: number; lon: number } } | undefined {
  const pc = f.primary_country;
  const fromPrimary = pc?.name
    ? { name: pc.name, location: toPoint(pc.location) }
    : undefined;
  if (fromPrimary) return fromPrimary;
  if (Array.isArray(f.country) && f.country.length) {
    const primary = f.country.find((c) => c.primary) ?? f.country[0];
    return { name: primary.name, location: toPoint(primary.location) };
  }
  return undefined;
}

function toPoint(loc: { lat?: number; lon?: number } | undefined): { lat: number; lon: number } | undefined {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return undefined;
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return undefined;
  if (Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) return undefined;
  return { lat: loc.lat, lon: loc.lon };
}

function pickType(type: ReliefwebFields['type']): string | undefined {
  if (Array.isArray(type)) return type[0]?.name;
  if (type && typeof type === 'object') return type.name;
  return undefined;
}

function pickSources(source: ReliefwebFields['source']): string[] | undefined {
  if (!Array.isArray(source) || source.length === 0) return undefined;
  const names = source
    .map((s) => s.shortname ?? s.name)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .slice(0, 6);
  return names.length ? names : undefined;
}

function pickDate(date: ReliefwebFields['date']): number {
  const s = date?.created ?? date?.original ?? date?.changed;
  if (!s) return Date.now();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

function summarize(f: ReliefwebFields): string {
  const body = (f.body ?? stripHtml(f['body-html']) ?? '').toString().trim();
  return body.length > 600 ? `${body.slice(0, 599)}…` : body;
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ongoing/alert disasters and multi-source reports rank higher. */
export function relevanceConfidence(f: ReliefwebFields, disasterType: string | undefined): number {
  let c = 0.5;
  const status = (f.status ?? '').toLowerCase();
  if (status === 'alert' || status === 'ongoing' || status === 'current') c += 0.2;
  if (disasterType) c += 0.1;
  const sourceCount = Array.isArray(f.source) ? f.source.length : 0;
  if (sourceCount >= 3) c += 0.1;
  return Math.min(0.95, Math.max(0.3, c));
}

function buildContent(item: ParsedReliefItem): string {
  const head = [
    item.country ? `Country: ${item.country}` : '',
    item.disasterType ? `Type: ${item.disasterType}` : '',
    item.status ? `Status: ${item.status}` : '',
    item.sources && item.sources.length ? `Sources: ${item.sources.join(', ')}` : '',
    item.url ? `URL: ${item.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [head, '', item.summary].filter((l) => l !== undefined && l !== '').join('\n').trim();
}

function clampCap(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CAP;
  return Math.min(MAX_CAP, Math.max(1, n));
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
