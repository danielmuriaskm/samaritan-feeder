import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * GDELT DOC 2.0 API — global news article monitoring.
 * Endpoint: https://api.gdeltproject.org/api/v2/doc/doc?query=...&format=json
 * (public, keyless). Emits one kind:'text' event per article in the result set
 * for a configured query, tagged with the publisher domain (and tone when the
 * tone-chart sort exposes it).
 *
 * Clean-room: tracking a topic across global news via GDELT DOC is inspired by
 * worldmonitor; the query construction, ArtList parsing, GDELT timestamp
 * handling, and confidence model below are derived from GDELT's own public DOC
 * 2.0 schema and are original.
 */

const DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_CAP = 40;
const MAX_CAP = 100;
const DEFAULT_TIMESPAN = '1d';

/** Normalized GDELT article emitted by the parser. */
export interface ParsedGdeltArticle {
  /** Stable upstream id — the article URL (GDELT has no separate id). */
  upstreamId: string;
  title: string;
  url: string;
  domain?: string;
  language?: string;
  sourceCountry?: string;
  tone?: number;
  /** epoch ms */
  eventAt: number;
  confidence: number;
}

interface GdeltArticle {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  tone?: number | string;
}

export class GdeltAdapter extends BaseAdapter {
  readonly kind = 'gdelt' as const;
  readonly name = 'GDELT DOC 2.0 (Global News)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.query !== 'string' || config.query.trim().length === 0) {
      errors.push('config.query is required (GDELT DOC search expression)');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    if (config.timespan !== undefined && typeof config.timespan !== 'string') {
      errors.push('config.timespan must be a string (e.g. "1d", "12h")');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const query = String(config.query).trim();
    const cap = clampCap(config.maxItems);
    const timespan = typeof config.timespan === 'string' && config.timespan.trim() ? config.timespan.trim() : DEFAULT_TIMESPAN;
    const sourceId = slugify(String(config.sourceId ?? `gdelt_${query}`));
    const since = cursor ? Number(cursor) : 0;

    const url = buildDocUrl(query, cap, timespan);

    let payload: unknown;
    try {
      const res = await safeFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'samaritan-feeder' },
        timeoutMs: 20000,
      });
      if (!res.ok) throw new Error(`GDELT fetch failed: ${res.status}`);
      // GDELT sometimes returns HTML error pages with a 200 — guard the JSON parse.
      const txt = await res.text();
      payload = safeJson(txt);
    } catch (err) {
      console.error('[gdelt] Poll failed:', err instanceof Error ? err.message : String(err));
      return [];
    }

    const articles = parseGdelt(payload).filter((a) => a.eventAt > since).slice(0, cap);

    return articles.map((a) =>
      this.makeEvent(
        {
          kind: 'text',
          title: a.title,
          content: buildContent(a),
          eventAt: a.eventAt,
          confidence: a.confidence,
          dedupeContent: `gdelt:${a.upstreamId}`,
          tags: {
            domain: a.domain,
            tone: a.tone,
            language: a.language,
            source_country: a.sourceCountry,
            url: a.url,
            query,
          },
        },
        sourceId,
      ),
    );
  }

  async health(_config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(buildDocUrl('weather', 1, '1d'), {
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

/** Build a DOC 2.0 ArtList request URL for a query. */
export function buildDocUrl(query: string, cap: number, timespan: string): string {
  const params = new URLSearchParams();
  params.set('query', query);
  params.set('mode', 'ArtList');
  params.set('format', 'json');
  params.set('maxrecords', String(Math.min(MAX_CAP, Math.max(1, cap))));
  params.set('sort', 'DateDesc');
  params.set('timespan', timespan);
  return `${DOC_API}?${params.toString()}`;
}

/** Parse a GDELT DOC ArtList JSON payload into normalized articles. */
export function parseGdelt(payload: unknown): ParsedGdeltArticle[] {
  const root = payload as { articles?: unknown } | null;
  if (!root || !Array.isArray(root.articles)) return [];
  const out: ParsedGdeltArticle[] = [];
  for (const raw of root.articles as GdeltArticle[]) {
    if (!raw || typeof raw !== 'object') continue;
    const urlStr = typeof raw.url === 'string' ? raw.url : '';
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!urlStr || !title) continue;
    const tone = parseTone(raw.tone);
    out.push({
      upstreamId: urlStr,
      title,
      url: urlStr,
      domain: typeof raw.domain === 'string' ? raw.domain : domainFromUrl(urlStr),
      language: typeof raw.language === 'string' ? raw.language : undefined,
      sourceCountry: typeof raw.sourcecountry === 'string' ? raw.sourcecountry : undefined,
      tone,
      eventAt: parseGdeltDate(raw.seendate),
      confidence: toneConfidence(tone),
    });
  }
  return out;
}

/**
 * GDELT seendate is "YYYYMMDDTHHMMSSZ" (compact ISO). Parse to epoch ms; fall
 * back to now() for anything that doesn't match.
 */
export function parseGdeltDate(s: string | undefined): number {
  if (typeof s !== 'string') return Date.now();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s.trim());
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

function parseTone(tone: number | string | undefined): number | undefined {
  if (typeof tone === 'number' && Number.isFinite(tone)) return tone;
  if (typeof tone === 'string') {
    const n = Number(tone);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Map article tone to a confidence proxy: strongly-toned coverage (very negative
 * or very positive) is more likely to be a notable event than neutral filler.
 * GDELT tone is roughly -100..+100 but clusters in -10..+10.
 */
export function toneConfidence(tone: number | undefined): number {
  if (tone === undefined) return 0.5;
  const magnitude = Math.min(10, Math.abs(tone)) / 10; // 0..1
  return Math.min(0.9, Math.max(0.4, 0.45 + magnitude * 0.4));
}

function buildContent(a: ParsedGdeltArticle): string {
  return [
    a.title,
    '',
    a.domain ? `Domain: ${a.domain}` : '',
    a.sourceCountry ? `Source country: ${a.sourceCountry}` : '',
    a.tone !== undefined ? `Tone: ${a.tone.toFixed(1)}` : '',
    `URL: ${a.url}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function safeJson(txt: string): unknown {
  const trimmed = txt.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function clampCap(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CAP;
  return Math.min(MAX_CAP, Math.max(1, n));
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
