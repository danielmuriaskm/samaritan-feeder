import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * OpenPhish (+ optional PhishTank) phishing-URL firehoses. Polls the keyless
 * OpenPhish community feed (one phishing URL per line) and, when configured,
 * PhishTank's online-valid CSV. Emits one kind:'alert' RawEvent per URL with
 * normalized {ioc_type:'url', threat:'phishing', host} tags.
 *
 * Clean-room: a port INSPIRED BY SpiderFoot (smicallef/spiderfoot, MIT) modules
 * sfp_openphish.py / sfp_phishtank.py — no code copied. The feed URLs, line/CSV
 * parsing, dedupe strategy, tag schema, and all strings/thresholds here are
 * original to this codebase.
 *
 * CRITICAL: these feeds carry NO per-item timestamp. We therefore dedupe on a
 * STABLE seed (`openphish:<url>`) rather than a timestamp cursor — re-polls of an
 * unchanged feed collapse to a single event per URL instead of re-emitting.
 *
 * Degrades to an empty array (never throws) on a non-200 / blocked response, and
 * caps the number of items per poll so a large feed can't flood the pipeline.
 */

const OPENPHISH_FEED = 'https://openphish.com/feed.txt';
const PHISHTANK_FEED = 'http://data.phishtank.com/data/online-valid.csv';
const DEFAULT_CAP = 500;
const MAX_CAP = 2000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Normalized phishing indicator the parser emits, before makeEvent wrapping. */
export interface PhishUrl {
  url: string;
  host: string;
  feed: 'openphish' | 'phishtank';
}

export class OpenphishAdapter extends BaseAdapter {
  readonly kind = 'openphish' as const;
  readonly name = 'OpenPhish / PhishTank (phishing URL feeds)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    if (config.phishtank !== undefined && typeof config.phishtank !== 'boolean') {
      errors.push('config.phishtank must be a boolean (enable the PhishTank feed)');
    }
    if (config.phishtankUrl !== undefined && typeof config.phishtankUrl !== 'string') {
      errors.push('config.phishtankUrl must be a string');
    }
    // Note (not an error): both feeds are keyless and timestamp-free; the adapter
    // dedupes on the URL and degrades to an empty poll on any non-200/blocked.
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const cap = clampCap(config.maxItems);
    const sourceId = slugify(String(config.sourceId ?? 'openphish'));
    const wantPhishtank = config.phishtank === true;
    const phishtankUrl =
      typeof config.phishtankUrl === 'string' && config.phishtankUrl.startsWith('http')
        ? config.phishtankUrl
        : PHISHTANK_FEED;

    const collected: PhishUrl[] = [];

    // OpenPhish: plain text, one URL per line.
    const openphishText = await this.fetchText(OPENPHISH_FEED, '[openphish] OpenPhish');
    if (openphishText !== null) {
      collected.push(...parseLineFeed(openphishText, 'openphish'));
    }

    // PhishTank (opt-in): CSV with a `url` column.
    if (wantPhishtank) {
      const phishtankText = await this.fetchText(phishtankUrl, '[openphish] PhishTank');
      if (phishtankText !== null) {
        collected.push(...parsePhishtankCsv(phishtankText));
      }
    }

    // De-dup within the poll (the two feeds overlap) and cap to avoid flooding.
    const seen = new Set<string>();
    const events: RawEvent[] = [];
    for (const item of collected) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Phishing URL: ${item.host}`,
            content: item.url,
            eventAt: Date.now(),
            confidence: 0.6,
            // Stable seed — the feeds have no per-item timestamp, so keying on the
            // URL collapses re-polls of an unchanged feed to one event per URL.
            dedupeContent: `openphish:${item.url}`,
            tags: {
              ioc_type: 'url',
              threat: 'phishing',
              feed: item.feed,
              host: item.host,
            },
          },
          sourceId,
        ),
      );
      if (events.length >= cap) break;
    }

    return events;
  }

  async health(_config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      // A HEAD against the OpenPhish host confirms reachability without pulling
      // the (sizable) feed body.
      const res = await safeFetch('https://openphish.com/', {
        method: 'HEAD',
        headers: { 'User-Agent': BROWSER_UA },
        timeoutMs: 10000,
      });
      return { healthy: res.status < 500, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  /** Fetch a text body, returning null (never throwing) on any non-200/blocked. */
  private async fetchText(url: string, label: string): Promise<string | null> {
    try {
      const res = await safeFetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain, text/csv, */*' },
        timeoutMs: 20000,
        maxBodyBytes: 16 * 1024 * 1024,
      });
      if (!res.ok) {
        console.warn(`${label} feed returned ${res.status}; degrading to empty poll.`);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.error(`${label} poll failed:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-testable)
// ---------------------------------------------------------------------------

/** Parse a newline-delimited "one URL per line" feed (OpenPhish). */
export function parseLineFeed(text: string, feed: 'openphish' | 'phishtank'): PhishUrl[] {
  const out: PhishUrl[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim();
    if (!url || url.startsWith('#') || !/^https?:\/\//i.test(url)) continue;
    const host = hostOf(url);
    if (!host) continue;
    out.push({ url, host, feed });
  }
  return out;
}

/**
 * Parse PhishTank's `online-valid.csv`. Columns include
 * phish_id,url,phish_detail_url,submission_time,... — we only need `url`, found
 * via the header row (falling back to column index 1).
 */
export function parsePhishtankCsv(text: string): PhishUrl[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let urlIdx = header.indexOf('url');
  const hasHeader = urlIdx !== -1;
  if (!hasHeader) urlIdx = 1; // PhishTank's url is the 2nd column when unlabeled.

  const out: PhishUrl[] = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cols = splitCsvLine(raw);
    const url = (cols[urlIdx] ?? '').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const host = hostOf(url);
    if (!host) continue;
    out.push({ url, host, feed: 'phishtank' });
  }
  return out;
}

/** Minimal CSV line splitter handling double-quoted fields with escaped quotes. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Extract the host from a URL via the WHATWG parser, or '' if it won't parse. */
function hostOf(u: string): string {
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
