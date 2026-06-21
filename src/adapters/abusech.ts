import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * abuse.ch IOC feeds (URLhaus recent malware URLs by default; ThreatFox IOCs
 * when config.feed === 'threatfox'). Emits one kind:'alert' RawEvent per
 * indicator with normalized {ioc_type, threat, malware} tags.
 *
 * Clean-room: method (poll a public abuse.ch JSON feed, normalize indicators
 * into alert events keyed on the upstream record id) is inspired by worldmonitor
 * but every endpoint shape below is parsed from abuse.ch's own public schema and
 * all strings/thresholds here are original.
 *
 * Auth: most abuse.ch feeds now require an `Auth-Key` header tied to a free
 * account. We accept config.authKey (or fall back to the legacy keyless feed)
 * and degrade gracefully — a 401/403 yields an empty poll, not a throw, and
 * validate() notes the requirement.
 */

const URLHAUS_RECENT = 'https://urlhaus.abuse.ch/downloads/json_recent/';
const THREATFOX_API = 'https://threatfox-api.abuse.ch/api/v1/';
const DEFAULT_CAP = 60;
const MAX_CAP = 200;

export type AbusechFeed = 'urlhaus' | 'threatfox';

/** Normalized indicator the parser emits, before makeEvent wrapping. */
export interface ParsedIoc {
  /** Stable upstream id used for dedupe (urlhaus id / threatfox ioc id). */
  upstreamId: string;
  iocType: 'url' | 'domain' | 'ip' | 'ip:port' | 'md5' | 'sha256' | 'unknown';
  value: string;
  threat?: string;
  malware?: string;
  tags?: string[];
  reference?: string;
  /** epoch ms */
  eventAt: number;
  confidence: number;
}

interface UrlhausEntry {
  id?: string | number;
  url?: string;
  url_status?: string;
  host?: string;
  date_added?: string;
  threat?: string;
  tags?: string[] | null;
  urlhaus_reference?: string;
  reporter?: string;
}

interface ThreatfoxEntry {
  id?: string | number;
  ioc?: string;
  ioc_type?: string;
  threat_type?: string;
  malware?: string;
  malware_printable?: string;
  confidence_level?: number;
  first_seen?: string;
  reference?: string;
  tags?: string[] | null;
}

export class AbusechAdapter extends BaseAdapter {
  readonly kind = 'abusech' as const;
  readonly name = 'abuse.ch (URLhaus / ThreatFox IOCs)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.feed !== undefined && config.feed !== 'urlhaus' && config.feed !== 'threatfox') {
      errors.push("config.feed must be 'urlhaus' or 'threatfox' when set");
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    if (config.authKey !== undefined && typeof config.authKey !== 'string') {
      errors.push('config.authKey must be a string (abuse.ch Auth-Key)');
    }
    // Note (not an error): most abuse.ch feeds now require config.authKey; the
    // adapter degrades to an empty poll on 401/403 rather than failing.
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const feed: AbusechFeed = config.feed === 'threatfox' ? 'threatfox' : 'urlhaus';
    const cap = clampCap(config.maxItems);
    const sourceId = slugify(String(config.sourceId ?? `abusech_${feed}`));
    const since = cursor ? Number(cursor) : 0;
    const authKey = typeof config.authKey === 'string' ? config.authKey : undefined;

    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'samaritan-feeder' };
    if (authKey) headers['Auth-Key'] = authKey;

    let payload: unknown;
    try {
      if (feed === 'threatfox') {
        const days = Math.min(7, Math.max(1, Number(config.days ?? 1)));
        const res = await safeFetch(THREATFOX_API, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'get_iocs', days }),
          timeoutMs: 20000,
        });
        if (isAuthFailure(res.status)) {
          console.warn('[abusech] ThreatFox auth failure (needs Auth-Key); degrading to empty poll.');
          return [];
        }
        if (!res.ok) throw new Error(`ThreatFox fetch failed: ${res.status}`);
        payload = await res.json();
      } else {
        const res = await safeFetch(URLHAUS_RECENT, { headers, timeoutMs: 20000, maxBodyBytes: 16 * 1024 * 1024 });
        if (isAuthFailure(res.status)) {
          console.warn('[abusech] URLhaus auth failure (needs Auth-Key); degrading to empty poll.');
          return [];
        }
        if (!res.ok) throw new Error(`URLhaus fetch failed: ${res.status}`);
        payload = await res.json();
      }
    } catch (err) {
      console.error('[abusech] Poll failed:', err instanceof Error ? err.message : String(err));
      return [];
    }

    const iocs = parseAbusech(payload, feed).filter((i) => i.eventAt > since).slice(0, cap);

    return iocs.map((ioc) =>
      this.makeEvent(
        {
          kind: 'alert',
          title: `IOC (${ioc.iocType}): ${truncate(ioc.value, 80)}`,
          content: buildContent(ioc, feed),
          eventAt: ioc.eventAt,
          confidence: ioc.confidence,
          // Dedupe on the stable upstream record id so re-polls don't re-emit.
          dedupeContent: `abusech:${feed}:${ioc.upstreamId}`,
          tags: {
            feed,
            ioc_type: ioc.iocType,
            ioc_value: ioc.value,
            threat: ioc.threat,
            malware: ioc.malware,
            abusech_tags: ioc.tags,
            reference: ioc.reference,
          },
        },
        sourceId,
      ),
    );
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const feed: AbusechFeed = config.feed === 'threatfox' ? 'threatfox' : 'urlhaus';
    const start = performance.now();
    try {
      // A HEAD against the docs host is enough to confirm reachability without
      // burning the (rate-limited) data endpoint.
      const url = feed === 'threatfox' ? 'https://threatfox.abuse.ch/' : 'https://urlhaus.abuse.ch/';
      const res = await safeFetch(url, { method: 'HEAD', timeoutMs: 10000 });
      // 2xx/3xx/405 all confirm the host is up; only treat connection errors as unhealthy.
      return { healthy: res.status < 500, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-tested)
// ---------------------------------------------------------------------------

/** Parse a URLhaus or ThreatFox payload into normalized indicators. */
export function parseAbusech(payload: unknown, feed: AbusechFeed): ParsedIoc[] {
  if (feed === 'threatfox') return parseThreatfox(payload);
  return parseUrlhaus(payload);
}

function parseUrlhaus(payload: unknown): ParsedIoc[] {
  // URLhaus json_recent is an object keyed by id, each value an array of entries.
  if (!payload || typeof payload !== 'object') return [];
  const out: ParsedIoc[] = [];
  for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
    const entry = Array.isArray(val) ? (val[0] as UrlhausEntry | undefined) : (val as UrlhausEntry);
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') continue;
    const upstreamId = String(entry.id ?? key);
    const eventAt = parseAbusechDate(entry.date_added);
    const online = (entry.url_status ?? '').toLowerCase() === 'online';
    out.push({
      upstreamId,
      iocType: 'url',
      value: entry.url,
      threat: entry.threat,
      malware: firstTag(entry.tags),
      tags: cleanTags(entry.tags),
      reference: entry.urlhaus_reference,
      eventAt,
      // Online malware URLs are higher-signal than dead ones.
      confidence: online ? 0.85 : 0.6,
    });
  }
  return out;
}

function parseThreatfox(payload: unknown): ParsedIoc[] {
  const root = payload as { query_status?: string; data?: unknown } | null;
  if (!root || root.query_status !== 'ok' || !Array.isArray(root.data)) return [];
  const out: ParsedIoc[] = [];
  for (const raw of root.data as ThreatfoxEntry[]) {
    if (!raw || typeof raw.ioc !== 'string') continue;
    const upstreamId = String(raw.id ?? raw.ioc);
    const conf = typeof raw.confidence_level === 'number' ? clamp01(raw.confidence_level / 100) : 0.7;
    out.push({
      upstreamId,
      iocType: normalizeIocType(raw.ioc_type),
      value: raw.ioc,
      threat: raw.threat_type,
      malware: raw.malware_printable ?? raw.malware,
      tags: cleanTags(raw.tags),
      reference: raw.reference,
      eventAt: parseAbusechDate(raw.first_seen),
      confidence: conf,
    });
  }
  return out;
}

function normalizeIocType(t: string | undefined): ParsedIoc['iocType'] {
  switch ((t ?? '').toLowerCase()) {
    case 'url':
      return 'url';
    case 'domain':
      return 'domain';
    case 'ip:port':
      return 'ip:port';
    case 'ip':
      return 'ip';
    case 'md5_hash':
    case 'md5':
      return 'md5';
    case 'sha256_hash':
    case 'sha256':
      return 'sha256';
    default:
      return 'unknown';
  }
}

/** abuse.ch timestamps look like "2024-01-02 03:04:05 UTC"; parse to epoch ms. */
export function parseAbusechDate(s: string | undefined): number {
  if (!s) return Date.now();
  const normalized = s.replace(' UTC', 'Z').replace(' ', 'T');
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : Date.now();
}

function buildContent(ioc: ParsedIoc, feed: AbusechFeed): string {
  const lines = [
    `Indicator: ${ioc.value}`,
    `Type: ${ioc.iocType}`,
    ioc.threat ? `Threat: ${ioc.threat}` : '',
    ioc.malware ? `Malware: ${ioc.malware}` : '',
    ioc.tags && ioc.tags.length ? `Tags: ${ioc.tags.join(', ')}` : '',
    ioc.reference ? `Reference: ${ioc.reference}` : '',
    `Source: abuse.ch ${feed}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function firstTag(tags: string[] | null | undefined): string | undefined {
  const c = cleanTags(tags);
  return c.length ? c[0] : undefined;
}

function cleanTags(tags: string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 12);
}

function clampCap(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CAP;
  return Math.min(MAX_CAP, Math.max(1, n));
}

/** abuse.ch now gates several feeds behind an Auth-Key; 401/403 => degrade to empty poll. */
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
