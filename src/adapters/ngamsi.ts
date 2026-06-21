import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * NGA Maritime Safety Information (MSI) broadcast / navigational warnings.
 * Endpoint: https://msi.nga.mil/api/publications/broadcast-warn (public, keyless).
 * Emits one kind:'anomaly' RawEvent per active warning, attaching a coarse
 * location when the warning carries a usable lat/lon.
 *
 * Clean-room: the idea of polling MSI broadcast warnings as a maritime signal is
 * inspired by worldmonitor; the field parsing, geometry extraction, severity
 * heuristics, and all strings below are derived from NGA's own MSI API schema.
 */

const MSI_BROADCAST = 'https://msi.nga.mil/api/publications/broadcast-warn';
const DEFAULT_CAP = 80;
const MAX_CAP = 250;

/** Normalized nav warning emitted by the parser. */
export interface ParsedNavWarning {
  /** Stable upstream id (msgYear/msgNumber/navArea) for dedupe. */
  upstreamId: string;
  navArea?: string;
  number?: number;
  year?: number;
  subregion?: string;
  text: string;
  status?: string;
  /** epoch ms of issuance. */
  eventAt: number;
  location?: { lat: number; lon: number };
  /** 0..1, higher = more navigation-critical wording. */
  confidence: number;
}

interface MsiBroadcastWarning {
  msgYear?: number;
  msgNumber?: number;
  navArea?: string;
  subregion?: string;
  text?: string;
  status?: string;
  issueDate?: string;
  authority?: string;
  cancelDate?: string;
  msgType?: string;
}

export class NgaMsiAdapter extends BaseAdapter {
  readonly kind = 'ngamsi' as const;
  readonly name = 'NGA MSI (Maritime Broadcast Warnings)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.navArea !== undefined && typeof config.navArea !== 'string') {
      errors.push('config.navArea must be a string (e.g. "IV", "HYDROPAC")');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const cap = clampCap(config.maxItems);
    const sourceId = slugify(String(config.sourceId ?? 'ngamsi_broadcast'));
    const since = cursor ? Number(cursor) : 0;

    const params = new URLSearchParams({ status: 'active', output: 'json' });
    const navArea = typeof config.navArea === 'string' ? config.navArea.trim() : '';
    if (navArea) params.set('navArea', navArea);
    const url = `${MSI_BROADCAST}?${params.toString()}`;

    let payload: unknown;
    try {
      const res = await safeFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'samaritan-feeder' },
        timeoutMs: 20000,
      });
      if (!res.ok) throw new Error(`NGA MSI fetch failed: ${res.status}`);
      payload = await res.json();
    } catch (err) {
      console.error('[ngamsi] Poll failed:', err instanceof Error ? err.message : String(err));
      return [];
    }

    const warnings = parseNgaMsi(payload).filter((w) => w.eventAt > since).slice(0, cap);

    return warnings.map((w) =>
      this.makeEvent(
        {
          kind: 'anomaly',
          title: `NAVWARN ${w.navArea ?? '?'} ${w.number ?? ''}/${w.year ?? ''}`.trim(),
          content: buildContent(w),
          eventAt: w.eventAt,
          confidence: w.confidence,
          location: w.location,
          dedupeContent: `ngamsi:${w.upstreamId}`,
          tags: {
            nav_area: w.navArea,
            number: w.number,
            year: w.year,
            subregion: w.subregion,
            status: w.status,
            has_location: w.location !== undefined,
          },
        },
        sourceId,
      ),
    );
  }

  async health(_config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(`${MSI_BROADCAST}?status=active&output=json`, {
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
// Pure parsing (unit-tested)
// ---------------------------------------------------------------------------

/** Parse the MSI broadcast-warn response into normalized nav warnings. */
export function parseNgaMsi(payload: unknown): ParsedNavWarning[] {
  const list = extractList(payload);
  const out: ParsedNavWarning[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as MsiBroadcastWarning;
    const text = typeof w.text === 'string' ? w.text.trim() : '';
    if (!text) continue;
    const navArea = typeof w.navArea === 'string' ? w.navArea : undefined;
    const number = typeof w.msgNumber === 'number' ? w.msgNumber : undefined;
    const year = typeof w.msgYear === 'number' ? w.msgYear : undefined;
    const upstreamId = [navArea ?? 'NA', year ?? 0, number ?? 0].join('/');
    out.push({
      upstreamId,
      navArea,
      number,
      year,
      subregion: typeof w.subregion === 'string' ? w.subregion : undefined,
      text,
      status: typeof w.status === 'string' ? w.status : undefined,
      eventAt: parseMsiDate(w.issueDate),
      location: extractLocation(text),
      confidence: severityConfidence(text),
    });
  }
  return out;
}

/** The MSI API returns either an array or a {broadcast-warn:[...]} envelope. */
function extractList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['broadcast-warn', 'broadcastWarnings', 'data', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/**
 * Best-effort first-coordinate extraction from NAVWARN free text. MSI positions
 * are written like "12-34.5N 098-76.5E" (deg-min) — pull the first such pair so
 * the event carries a usable point. Returns undefined when nothing parses.
 */
export function extractLocation(text: string): { lat: number; lon: number } | undefined {
  const re = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/i;
  const m = re.exec(text);
  if (!m) return undefined;
  const lat = dmToDecimal(Number(m[1]), Number(m[2]), m[3]);
  const lon = dmToDecimal(Number(m[4]), Number(m[5]), m[6]);
  if (lat === null || lon === null) return undefined;
  return { lat, lon };
}

function dmToDecimal(deg: number, min: number, hemi: string): number | null {
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  let dec = deg + min / 60;
  const h = hemi.toUpperCase();
  if (h === 'S' || h === 'W') dec = -dec;
  if (Math.abs(dec) > 180) return null;
  if ((h === 'N' || h === 'S') && Math.abs(dec) > 90) return null;
  return Number(dec.toFixed(5));
}

/** Bump confidence for navigation-critical wording; clamp into a sane band. */
export function severityConfidence(text: string): number {
  const t = text.toLowerCase();
  let c = 0.55;
  if (/\b(dangerous|hazard|explosive|mine|unexploded|missile|firing|gunnery)\b/.test(t)) c += 0.2;
  if (/\b(wreck|obstruction|adrift|derelict|disabled)\b/.test(t)) c += 0.1;
  if (/\b(light|buoy|beacon)\b.*\b(unreliable|extinguished|off station)\b/.test(t)) c += 0.05;
  return Math.min(0.95, Math.max(0.4, c));
}

function buildContent(w: ParsedNavWarning): string {
  const head = [
    w.navArea ? `NAV AREA ${w.navArea}` : '',
    w.number && w.year ? `Warning ${w.number}/${w.year}` : '',
    w.subregion ? `Subregion ${w.subregion}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return [head, '', w.text].filter((l) => l !== undefined).join('\n').trim();
}

/** MSI issueDate is typically ISO-ish or "DDHHMMZ MON YYYY"; fall back to now. */
export function parseMsiDate(s: string | undefined): number {
  if (!s) return Date.now();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

function clampCap(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CAP;
  return Math.min(MAX_CAP, Math.max(1, n));
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
