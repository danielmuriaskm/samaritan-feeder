import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from '../util/safeFetch.js';

/**
 * Zone-H special-defacements RSS feed. Polls Zone-H's near-real-time RSS of
 * notable website defacements and emits one kind:'alert' RawEvent per entry,
 * tagged so the existing reconDomain processor (which reads tags.domain /
 * tags.domains) picks up the defaced host.
 *
 * Clean-room: a port INSPIRED BY SpiderFoot (smicallef/spiderfoot, MIT) module
 * sfp_zoneh.py — no code copied. The feed URL, XML parsing (via fast-xml-parser,
 * mirroring src/adapters/rss.ts), tag schema, dedupe strategy, and all
 * strings/thresholds here are original to this codebase.
 *
 * Confidence is modest (~0.4): Zone-H defacement reports are self-submitted and
 * unverified. The feed is frequently Cloudflare-gated / rate-limited, so a
 * non-200/blocked response degrades to an empty array rather than throwing.
 * dedupeContent keys on the defaced host (falling back to the entry permalink)
 * so re-polls collapse to one event.
 */

const DEFAULT_FEED = 'https://www.zone-h.org/rss/specialdefacements';
const DEFAULT_CAP = 100;
const MAX_CAP = 500;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Normalized defacement entry the parser emits, before makeEvent wrapping. */
export interface ZonehEntry {
  /** Defaced host (when parseable from the title/link), else ''. */
  host: string;
  title: string;
  link: string;
}

export class ZonehAdapter extends BaseAdapter {
  readonly kind = 'zoneh' as const;
  readonly name = 'Zone-H (website defacements)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.url !== undefined && (typeof config.url !== 'string' || !config.url.startsWith('http'))) {
      errors.push('config.url must be a valid HTTP(S) URL when set');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    // Note (not an error): Zone-H is often Cloudflare-gated; the adapter degrades
    // to an empty poll on any non-200/blocked response rather than failing.
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const url = typeof config.url === 'string' && config.url.startsWith('http') ? config.url : DEFAULT_FEED;
    const cap = clampCap(config.maxItems);
    const sourceId = slugify(String(config.sourceId ?? 'zoneh'));

    let xml: string;
    try {
      const res = await safeFetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        },
        timeoutMs: 20000,
      });
      if (!res.ok) {
        console.warn(`[zoneh] feed returned ${res.status} (Cloudflare-gated?); degrading to empty poll.`);
        return [];
      }
      xml = await res.text();
    } catch (err) {
      console.error('[zoneh] Poll failed:', err instanceof Error ? err.message : String(err));
      return [];
    }

    let entries: ZonehEntry[];
    try {
      entries = parseZonehRss(xml);
    } catch (err) {
      console.error('[zoneh] RSS parse failed:', err instanceof Error ? err.message : String(err));
      return [];
    }

    return entries.slice(0, cap).map((entry) => {
      const host = entry.host || hostOf(entry.link);
      const dedupeSeed = host || entry.link || entry.title;
      return this.makeEvent(
        {
          kind: 'alert',
          title: host ? `Defacement: ${host}` : entry.title || 'Website defacement (Zone-H)',
          content: buildContent(entry, host),
          eventAt: Date.now(),
          confidence: 0.4,
          // Stable seed — keying on the defaced host (or permalink) collapses
          // re-polls of an unchanged feed to one event.
          dedupeContent: `zoneh:${dedupeSeed}`,
          tags: {
            recon_type: 'defacement',
            defaced: true,
            defaced_host: host || undefined,
            feed: 'zoneh',
            link: entry.link || undefined,
            // reconDomain processor reads tags.domain / tags.domains.
            domain: host || undefined,
            domains: host ? [host] : undefined,
          },
        },
        sourceId,
      );
    });
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const url = typeof config.url === 'string' && config.url.startsWith('http') ? config.url : DEFAULT_FEED;
    const start = performance.now();
    try {
      const res = await safeFetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': BROWSER_UA },
        timeoutMs: 10000,
      });
      // Zone-H sits behind Cloudflare; anything short of a 5xx confirms reachability.
      return { healthy: res.status < 500, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-testable)
// ---------------------------------------------------------------------------

/** Parse a Zone-H RSS feed into normalized defacement entries. */
export function parseZonehRss(xml: string): ZonehEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    // Match rss.ts: disable entity expansion to dodge "Entity expansion limit
    // exceeded" on hostile/large feeds.
    processEntities: false,
  });
  const feed = parser.parse(xml);

  const channel =
    feed?.rss && typeof feed.rss === 'object' ? (feed.rss as Record<string, unknown>).channel : undefined;
  const rawItems = channel && typeof channel === 'object' ? (channel as Record<string, unknown>).item : undefined;
  const items = Array.isArray(rawItems)
    ? (rawItems as Record<string, unknown>[])
    : rawItems
      ? [rawItems as Record<string, unknown>]
      : [];

  const out: ZonehEntry[] = [];
  for (const item of items) {
    const title = strOf(item.title);
    const link = strOf(item.link);
    // Zone-H titles are typically the defaced host/URL; prefer parsing a host
    // from the title, else from the link.
    const host = hostFromTitle(title) || hostOf(link);
    out.push({ host, title, link });
  }
  return out;
}

/**
 * Best-effort host extraction from a Zone-H item title. Titles are usually the
 * bare host or a defaced URL; we strip any scheme/path and validate the result
 * looks like a hostname.
 */
function hostFromTitle(title: string): string {
  const t = title.trim();
  if (!t) return '';
  // If it parses as a URL, use the URL host.
  const direct = hostOf(t);
  if (direct) return direct;
  // Otherwise take the first whitespace-delimited token and strip a path.
  const token = t.split(/\s+/)[0] ?? '';
  const hostPart = token.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? '';
  // Accept only something that looks like a dotted hostname (no spaces, has a dot).
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(hostPart)) return hostPart.toLowerCase();
  return '';
}

function buildContent(entry: ZonehEntry, host: string): string {
  const lines = [
    host ? `Defaced host: ${host}` : '',
    entry.title ? `Report: ${entry.title}` : '',
    entry.link ? `Reference: ${entry.link}` : '',
    'Source: Zone-H special defacements (self-reported, unverified)',
  ];
  return lines.filter(Boolean).join('\n');
}

function strOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/** Extract the host from a URL via the WHATWG parser, or '' if it won't parse. */
function hostOf(u: string): string {
  if (!u || !/^https?:\/\//i.test(u)) return '';
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

function clampCap(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CAP;
  return Math.min(MAX_CAP, Math.max(1, n));
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
