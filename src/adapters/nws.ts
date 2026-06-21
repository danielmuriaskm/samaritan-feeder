import { BaseAdapter } from './base.js';
import type { RawEvent, EventKind } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';
import type { MakeEvent } from './usgs.js';

/**
 * US National Weather Service (api.weather.gov) active-alerts adapter.
 *
 * Clean-room: only the *idea* of polling NWS active alerts is taken from
 * worldmonitor. The endpoint, GeoJSON alert shape, and the CAP severity/urgency
 * vocabulary are facts published by NWS/NOAA (https://www.weather.gov/documentation/services-web-api).
 * No upstream code, prompts, or curated tables are reused.
 *
 * NWS requires a descriptive User-Agent (they 403 generic clients); we set one.
 */

const ALERTS_URL = 'https://api.weather.gov/alerts/active';
const MAX_EVENTS = 50;
// NWS asks clients to identify themselves. Our own contact string (not copied).
const USER_AGENT = 'samaritan-feeder/0.1 (+https://github.com/danielmurias-prz/samaritan-feeder)';

interface NwsGeometry {
  type?: string;
  coordinates?: unknown;
}

interface NwsAlertProps {
  id?: string;
  event?: string; // e.g. "Tornado Warning"
  severity?: string; // Extreme | Severe | Moderate | Minor | Unknown
  certainty?: string;
  urgency?: string;
  areaDesc?: string;
  headline?: string | null;
  description?: string | null;
  instruction?: string | null;
  sent?: string;
  effective?: string;
  onset?: string | null;
  expires?: string | null;
  status?: string;
  messageType?: string; // Alert | Update | Cancel
}

interface NwsFeature {
  id?: string;
  geometry?: NwsGeometry | null;
  properties?: NwsAlertProps;
}

interface NwsPayload {
  features?: NwsFeature[];
}

/** CAP severity -> confidence. Our own mapping. */
export function severityConfidence(severity: string | undefined): number {
  switch (String(severity ?? '').toLowerCase()) {
    case 'extreme':
      return 0.97;
    case 'severe':
      return 0.88;
    case 'moderate':
      return 0.72;
    case 'minor':
      return 0.58;
    default:
      return 0.5;
  }
}

/** Severe/Extreme alerts are push-worthy ('alert'); the rest are recorded as 'text'. */
function severityKind(severity: string | undefined): EventKind {
  const s = String(severity ?? '').toLowerCase();
  return s === 'extreme' || s === 'severe' ? 'alert' : 'text';
}

/**
 * Compute a representative point from an alert geometry. NWS alerts are usually
 * Polygon/MultiPolygon over an affected area; we take the centroid of the first
 * ring's vertices as a coarse marker (good enough for geo-correlation).
 */
function representativePoint(geom: NwsGeometry | null | undefined): { lat: number; lon: number } | undefined {
  if (!geom || !Array.isArray(geom.coordinates)) return undefined;
  // Drill down to the first array of [lon,lat] pairs regardless of nesting depth.
  let node: unknown = geom.coordinates;
  while (Array.isArray(node) && Array.isArray(node[0]) && Array.isArray((node[0] as unknown[])[0])) {
    node = node[0];
  }
  if (!Array.isArray(node)) return undefined;
  const ring = node as unknown[];
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  for (const pt of ring) {
    if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
      sumLon += pt[0];
      sumLat += pt[1];
      n++;
    }
  }
  if (n === 0) return undefined;
  return { lat: sumLat / n, lon: sumLon / n };
}

function parseIso(input: string | null | undefined): number | undefined {
  if (typeof input !== 'string') return undefined;
  const ts = Date.parse(input);
  return Number.isNaN(ts) ? undefined : ts;
}

/**
 * Pure parser: NWS alerts payload -> RawEvent[]. Exported for unit testing
 * without network. `minSeverity` (minor<moderate<severe<extreme) filters out
 * lower-severity alerts; cancellations are skipped.
 */
export function parseNws(
  payload: NwsPayload,
  opts: {
    sourceId: string;
    minSeverity?: 'minor' | 'moderate' | 'severe' | 'extreme';
    max?: number;
    makeEvent: MakeEvent;
  },
): RawEvent[] {
  const { sourceId, makeEvent } = opts;
  const max = opts.max ?? MAX_EVENTS;
  const rank: Record<string, number> = { minor: 0, moderate: 1, severe: 2, extreme: 3 };
  const minRank = opts.minSeverity ? rank[opts.minSeverity] : -1;
  const list = Array.isArray(payload.features) ? payload.features : [];
  const events: RawEvent[] = [];

  for (const f of list) {
    if (events.length >= max) break;
    const p = f.properties ?? {};
    // Skip cancellations — they retract, not add, intelligence.
    if (String(p.messageType ?? '').toLowerCase() === 'cancel') continue;

    const sev = String(p.severity ?? '').toLowerCase();
    if (minRank >= 0 && (rank[sev] ?? -1) < minRank) continue;

    const eventName = p.event ?? 'Weather Alert';
    const area = p.areaDesc ?? 'unspecified area';
    const eventAt = parseIso(p.onset) ?? parseIso(p.effective) ?? parseIso(p.sent) ?? Date.now();
    const id = p.id ?? f.id;

    const contentLines = [
      p.headline ?? `${eventName} — ${area}`,
      `Severity: ${p.severity ?? 'Unknown'}`,
      p.urgency ? `Urgency: ${p.urgency}` : '',
      p.certainty ? `Certainty: ${p.certainty}` : '',
      `Area: ${area}`,
      p.description ? String(p.description) : '',
      p.instruction ? `Instruction: ${p.instruction}` : '',
    ].filter(Boolean);

    events.push(
      makeEvent(
        {
          kind: severityKind(p.severity),
          title: `NWS ${p.severity ?? ''} ${eventName}`.replace(/\s+/g, ' ').trim(),
          content: contentLines.join('\n'),
          eventAt,
          confidence: severityConfidence(p.severity),
          location: representativePoint(f.geometry),
          dedupeContent: id ? `nws:${id}` : undefined,
          tags: {
            nws_id: id,
            event: eventName,
            severity: p.severity ?? undefined,
            urgency: p.urgency ?? undefined,
            certainty: p.certainty ?? undefined,
            area_desc: area,
            message_type: p.messageType ?? undefined,
            expires: p.expires ?? undefined,
          },
          rawData: f as Record<string, unknown>,
        },
        sourceId,
      ),
    );
  }

  return events;
}

export class NwsAdapter extends BaseAdapter {
  readonly kind = 'nws' as const;
  readonly name = 'NWS Active Alerts';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (
      config.minSeverity !== undefined &&
      !['minor', 'moderate', 'severe', 'extreme'].includes(String(config.minSeverity).toLowerCase())
    ) {
      errors.push('minSeverity must be one of minor, moderate, severe, extreme');
    }
    if (config.area !== undefined && !/^[A-Z]{2}$/.test(String(config.area))) {
      errors.push('area must be a 2-letter state/marine code (e.g. "CA")');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const minSeverityRaw = config.minSeverity ? String(config.minSeverity).toLowerCase() : undefined;
    const minSeverity =
      minSeverityRaw === 'minor' || minSeverityRaw === 'moderate' || minSeverityRaw === 'severe' || minSeverityRaw === 'extreme'
        ? minSeverityRaw
        : undefined;
    const sourceId = String(config.sourceId ?? 'nws');

    const url = new URL(ALERTS_URL);
    url.searchParams.set('status', 'actual');
    if (typeof config.area === 'string' && /^[A-Z]{2}$/.test(config.area)) {
      url.searchParams.set('area', config.area);
    }
    // Default to severe+ unless the operator asks for more, to keep noise down.
    if (!minSeverity && config.area === undefined) {
      url.searchParams.set('severity', 'Severe,Extreme');
    }

    const res = await safeFetch(url.toString(), {
      headers: {
        Accept: 'application/geo+json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`NWS fetch failed: ${res.status} ${res.statusText}`);
    }

    const payload = (await res.json()) as NwsPayload;
    return parseNws(payload, { sourceId, minSeverity, makeEvent: this.makeEvent.bind(this) });
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(`${ALERTS_URL}?limit=1`, {
        headers: { Accept: 'application/geo+json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
