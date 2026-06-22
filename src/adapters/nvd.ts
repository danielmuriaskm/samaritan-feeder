import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * NVD CVE adapter (NIST National Vulnerability Database, REST API v2).
 *
 * Root cause this fixes: the NVD source was pointed at the legacy RSS feed
 * (`nvd.nist.gov/download/nvd-rss.xml`), which NIST RETIRED — it now returns
 * HTTP 403. So the source polled, got an error (or, parsed as RSS, zero items),
 * and went silent for ~11d while CVEs kept publishing. NVD's only supported feed
 * today is the JSON REST API v2 at services.nvd.nist.gov, which this adapter uses.
 *
 * IMPORTANT wiring note: registration lives in src/adapters/index.ts (a file this
 * change is fenced out of). To activate, add the single line
 *   registerAdapter(new NvdAdapter());
 * to that file's bootstrap block, and repoint the existing NVD source to
 * `kind:'nvd'` (it was almost certainly `kind:'rss'` on the dead URL).
 *
 * Config:
 *   - `windowHours`: how far back to ask for newly-PUBLISHED CVEs each poll
 *     (default 24; NVD caps a single request window at 120 days).
 *   - `minCvss`: drop CVEs whose best CVSS base score is below this (default 0 —
 *     keep all). E.g. 7.0 to watch only High/Critical.
 *   - `resultsPerPage`: page size (default 50, NVD max 2000).
 *   - `apiKey`: optional NVD API key (raises the rate limit; sent as the
 *     `apiKey` header NVD documents).
 *
 * No upstream code or curated tables are copied; the request shape and the
 * field names below are facts published by NIST's API v2 documentation.
 */

const NVD_API = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_WINDOW_HOURS = 24;
const MAX_EVENTS = 200;

export type MakeEvent = (
  partial: Omit<RawEvent, 'sourceId'> & { sourceId?: string },
  sourceId: string,
) => RawEvent;

// --- API v2 response shapes (only the fields we read) ----------------------

interface NvdCvssData {
  baseScore?: number;
  baseSeverity?: string;
}
interface NvdMetric {
  cvssData?: NvdCvssData;
  baseSeverity?: string; // some metric versions surface severity at the top level
}
interface NvdCve {
  id?: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang?: string; value?: string }>;
  metrics?: Record<string, NvdMetric[]>;
  references?: Array<{ url?: string; source?: string }>;
}
interface NvdVulnerability {
  cve?: NvdCve;
}
export interface NvdPayload {
  totalResults?: number;
  vulnerabilities?: NvdVulnerability[];
}

/**
 * Pick the most relevant CVSS base score across all metric versions present
 * (NVD may carry cvssMetricV31 / V30 / V2). Prefers the highest base score so a
 * CVE is judged by its worst rating. Returns score + severity, or undefined.
 */
export function bestCvss(metrics: NvdCve['metrics']): { score: number; severity?: string } | undefined {
  if (!metrics || typeof metrics !== 'object') return undefined;
  let best: { score: number; severity?: string } | undefined;
  for (const list of Object.values(metrics)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const score = m?.cvssData?.baseScore;
      if (typeof score !== 'number' || Number.isNaN(score)) continue;
      const severity = m?.cvssData?.baseSeverity ?? m?.baseSeverity;
      if (!best || score > best.score) best = { score, severity };
    }
  }
  return best;
}

/** Map a CVSS base score (0..10) to a 0..1 confidence. Higher = more certain to matter. */
export function cvssConfidence(score: number | undefined): number {
  if (typeof score !== 'number' || Number.isNaN(score)) return 0.5;
  if (score >= 9) return 0.97;
  if (score >= 7) return 0.9;
  if (score >= 4) return 0.75;
  if (score > 0) return 0.6;
  return 0.5;
}

/** English description, falling back to the first available. */
function englishDescription(cve: NvdCve): string {
  const descs = Array.isArray(cve.descriptions) ? cve.descriptions : [];
  const en = descs.find((d) => d?.lang === 'en');
  return String((en ?? descs[0])?.value ?? '').trim();
}

/**
 * Pure parser: API v2 payload -> RawEvent[]. Exported for unit testing without
 * any network. `minCvss` drops low-severity CVEs; `since` (ms epoch) drops CVEs
 * not modified after the cursor so re-polls of the same window don't re-emit.
 */
export function parseNvd(
  payload: NvdPayload,
  opts: { sourceId: string; minCvss?: number; since?: number; max?: number; makeEvent: MakeEvent },
): RawEvent[] {
  const { sourceId, minCvss = 0, since = 0, makeEvent } = opts;
  const max = opts.max ?? MAX_EVENTS;
  const vulns = Array.isArray(payload?.vulnerabilities) ? payload.vulnerabilities : [];
  const events: RawEvent[] = [];

  for (const entry of vulns) {
    if (events.length >= max) break;
    const cve = entry?.cve;
    if (!cve || typeof cve.id !== 'string') continue;

    // Cursor is the upstream lastModified time; skip records not newer than it.
    const modifiedAt = cve.lastModified ? Date.parse(cve.lastModified) : NaN;
    const publishedAt = cve.published ? Date.parse(cve.published) : NaN;
    const eventAt = Number.isFinite(publishedAt)
      ? publishedAt
      : Number.isFinite(modifiedAt)
        ? modifiedAt
        : Date.now();
    const cursorAt = Number.isFinite(modifiedAt) ? modifiedAt : eventAt;
    if (cursorAt <= since) continue;

    const cvss = bestCvss(cve.metrics);
    if (typeof minCvss === 'number' && minCvss > 0) {
      if (!cvss || cvss.score < minCvss) continue;
    }

    const desc = englishDescription(cve);
    const severity = cvss?.severity ? String(cvss.severity).toUpperCase() : undefined;
    const scoreStr = cvss ? `CVSS ${cvss.score.toFixed(1)}${severity ? ` (${severity})` : ''}` : 'CVSS n/a';
    const primaryRef = cve.references?.find((r) => typeof r?.url === 'string')?.url;

    const contentLines = [
      desc,
      scoreStr,
      cve.vulnStatus ? `Status: ${cve.vulnStatus}` : '',
      primaryRef ? `Reference: ${primaryRef}` : '',
    ].filter(Boolean);

    events.push(
      makeEvent(
        {
          kind: 'alert',
          title: `${cve.id}${severity ? ` — ${severity}` : ''}`,
          content: contentLines.join('\n'),
          eventAt,
          confidence: cvssConfidence(cvss?.score),
          // Stable upstream id -> re-polls of the same CVE collapse to one event.
          dedupeContent: `nvd:${cve.id}`,
          tags: {
            cve_id: cve.id,
            cvss_base_score: cvss?.score,
            cvss_severity: severity,
            vuln_status: cve.vulnStatus,
            published: cve.published,
            last_modified: cve.lastModified,
            url: primaryRef,
          },
          rawData: cve as unknown as Record<string, unknown>,
        },
        sourceId,
      ),
    );
  }

  return events;
}

/** Format a Date as the NVD API's expected extended ISO-8601 (no trailing Z; millis). */
export function nvdDateParam(d: Date): string {
  // NVD wants e.g. 2026-06-20T00:00:00.000 — ISO without the trailing Z.
  return d.toISOString().replace(/Z$/, '');
}

export class NvdAdapter extends BaseAdapter {
  readonly kind = 'nvd' as const;
  readonly name = 'NVD CVE Feed';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.windowHours !== undefined && (typeof config.windowHours !== 'number' || config.windowHours <= 0)) {
      errors.push('windowHours must be a positive number');
    }
    if (config.minCvss !== undefined && (typeof config.minCvss !== 'number' || config.minCvss < 0 || config.minCvss > 10)) {
      errors.push('minCvss must be a number between 0 and 10');
    }
    if (config.resultsPerPage !== undefined && typeof config.resultsPerPage !== 'number') {
      errors.push('resultsPerPage must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  buildUrl(config: Record<string, unknown>, now: number = Date.now()): string {
    const windowHours = typeof config.windowHours === 'number' ? config.windowHours : DEFAULT_WINDOW_HOURS;
    const resultsPerPage = typeof config.resultsPerPage === 'number' ? config.resultsPerPage : 50;
    const start = new Date(now - windowHours * 60 * 60 * 1000);
    const end = new Date(now);
    const params = new URLSearchParams({
      pubStartDate: nvdDateParam(start),
      pubEndDate: nvdDateParam(end),
      resultsPerPage: String(Math.max(1, Math.min(2000, resultsPerPage))),
    });
    return `${NVD_API}?${params.toString()}`;
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const sourceId = String(config.sourceId ?? 'nvd');
    const minCvss = typeof config.minCvss === 'number' ? config.minCvss : 0;
    const since = cursor ? Number(cursor) : 0;
    const url = this.buildUrl(config);

    const headers: Record<string, string> = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };
    if (typeof config.apiKey === 'string' && config.apiKey) headers.apiKey = config.apiKey;

    // NVD's keyless endpoint is slow and behind Cloudflare; give it a generous
    // per-hop timeout (safeFetch's own default is 15s) so a slow-but-valid
    // response isn't aborted. A real hang still ends at the scheduler's 45s cap.
    let res: Response;
    try {
      res = await safeFetch(url, { headers, timeoutMs: 30000, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      // A timeout / transient network error to NVD is common when keyless and
      // throttled. Treat it as "nothing new this cycle" rather than tripping the
      // breaker and spamming logs; the next poll retries.
      console.warn(`[nvd] request failed (${err instanceof Error ? err.message : String(err)}); skipping this cycle`);
      return [];
    }
    if (!res.ok) {
      // NVD rate-limits aggressively (esp. keyless) with 403/429/503 — treat a
      // throttle as "nothing new this cycle" so it doesn't trip the breaker and
      // spam logs; a hard failure still surfaces.
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        console.warn(`[nvd] throttled (${res.status} ${res.statusText}); skipping this cycle`);
        return [];
      }
      throw new Error(`NVD fetch failed: ${res.status} ${res.statusText}`);
    }

    let payload: NvdPayload;
    try {
      payload = (await res.json()) as NvdPayload;
    } catch {
      console.warn('[nvd] non-JSON response (likely an interstitial); skipping this cycle');
      return [];
    }
    return parseNvd(payload, { sourceId, minCvss, since, makeEvent: this.makeEvent.bind(this) });
  }

  async health(_config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(`${NVD_API}?resultsPerPage=1`, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
