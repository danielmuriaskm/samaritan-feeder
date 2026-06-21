import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';
import type { MakeEvent } from './usgs.js';

/**
 * GDACS (Global Disaster Alert and Coordination System) adapter.
 *
 * Clean-room: only the *idea* of consuming GDACS' public alert list is taken
 * from worldmonitor. The GeoJSON endpoint and its property names (alertlevel,
 * eventtype, episodealertlevel, ...) are facts published by GDACS
 * (https://www.gdacs.org/gdacsapi/). No upstream code or strings are reused.
 *
 * GDACS classifies disasters (EQ, TC=tropical cyclone, FL=flood, VO=volcano,
 * DR=drought, WF=wildfire, TS=tsunami) with a Green/Orange/Red alert level.
 */

const GEOJSON_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const MAX_EVENTS = 50;

interface GdacsFeature {
  type?: string;
  properties?: {
    eventtype?: string; // EQ, TC, FL, VO, DR, WF, TS
    eventid?: number | string;
    episodeid?: number | string;
    name?: string;
    description?: string;
    htmldescription?: string;
    alertlevel?: string; // 'Green' | 'Orange' | 'Red'
    episodealertlevel?: string;
    fromdate?: string;
    todate?: string;
    iso3?: string;
    country?: string;
    severitydata?: { severity?: number; severitytext?: string; severityunit?: string };
    url?: { report?: string; details?: string };
  };
  geometry?: {
    type?: string;
    coordinates?: Array<number | null>; // [lon, lat]
  };
}

interface GdacsPayload {
  features?: GdacsFeature[];
}

const EVENT_TYPE_LABEL: Record<string, string> = {
  EQ: 'Earthquake',
  TC: 'Tropical Cyclone',
  FL: 'Flood',
  VO: 'Volcano',
  DR: 'Drought',
  WF: 'Wildfire',
  TS: 'Tsunami',
};

/** Map a GDACS alert level to confidence. Our own thresholds. */
export function alertLevelConfidence(level: string | undefined): number {
  switch (String(level ?? '').toLowerCase()) {
    case 'red':
      return 0.95;
    case 'orange':
      return 0.82;
    case 'green':
      return 0.6;
    default:
      return 0.55;
  }
}

function stripHtml(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure parser: GDACS GeoJSON payload -> RawEvent[]. Exported for unit testing
 * without network. `minLevel` (green<orange<red) drops lower-severity alerts.
 */
export function parseGdacs(
  payload: GdacsPayload,
  opts: {
    sourceId: string;
    minLevel?: 'green' | 'orange' | 'red';
    max?: number;
    makeEvent: MakeEvent;
  },
): RawEvent[] {
  const { sourceId, makeEvent } = opts;
  const max = opts.max ?? MAX_EVENTS;
  const rank: Record<string, number> = { green: 0, orange: 1, red: 2 };
  const minRank = opts.minLevel ? rank[opts.minLevel] : -1;
  const list = Array.isArray(payload.features) ? payload.features : [];
  const events: RawEvent[] = [];

  for (const f of list) {
    if (events.length >= max) break;
    const p = f.properties ?? {};
    const level = String(p.alertlevel ?? '').toLowerCase();
    if (minRank >= 0 && (rank[level] ?? -1) < minRank) continue;

    const coords = f.geometry?.coordinates ?? [];
    const lon = typeof coords[0] === 'number' ? coords[0] : undefined;
    const lat = typeof coords[1] === 'number' ? coords[1] : undefined;

    const typeCode = String(p.eventtype ?? '').toUpperCase();
    const typeLabel = EVENT_TYPE_LABEL[typeCode] ?? (typeCode || 'Disaster');
    const name = p.name ?? `${typeLabel} alert`;
    const levelLabel = p.alertlevel ? String(p.alertlevel).toUpperCase() : 'UNKNOWN';
    const eventAt = (() => {
      const ts = p.fromdate ? Date.parse(p.fromdate) : NaN;
      return Number.isNaN(ts) ? Date.now() : ts;
    })();
    const report = p.url?.report ?? p.url?.details;

    const contentLines = [
      `${typeLabel} — ${name}`,
      `Alert level: ${levelLabel}`,
      p.country ? `Country: ${p.country}` : '',
      p.severitydata?.severitytext ? `Severity: ${p.severitydata.severitytext}` : '',
      stripHtml(p.htmldescription) || stripHtml(p.description),
      report ? `Details: ${report}` : '',
    ].filter(Boolean);

    const stableId = p.eventid !== undefined ? `${typeCode}_${p.eventid}_${p.episodeid ?? ''}` : `${name}_${eventAt}`;

    events.push(
      makeEvent(
        {
          // Red/Orange are push-worthy alerts; green disasters are recorded as anomalies.
          kind: level === 'red' || level === 'orange' ? 'alert' : 'anomaly',
          title: `GDACS ${levelLabel}: ${typeLabel} — ${name}`,
          content: contentLines.join('\n'),
          eventAt,
          confidence: alertLevelConfidence(p.alertlevel),
          location: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
          dedupeContent: `gdacs:${stableId}`,
          tags: {
            gdacs_event_id: p.eventid,
            gdacs_episode_id: p.episodeid,
            event_type: typeCode,
            event_type_label: typeLabel,
            alert_level: level || undefined,
            country: p.country ?? undefined,
            iso3: p.iso3 ?? undefined,
            severity: p.severitydata?.severity,
            severity_text: p.severitydata?.severitytext,
            url: report,
          },
          rawData: f as Record<string, unknown>,
        },
        sourceId,
      ),
    );
  }

  return events;
}

export class GdacsAdapter extends BaseAdapter {
  readonly kind = 'gdacs' as const;
  readonly name = 'GDACS Disaster Alerts';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.minLevel !== undefined && !['green', 'orange', 'red'].includes(String(config.minLevel).toLowerCase())) {
      errors.push('minLevel must be one of green, orange, red');
    }
    if (config.eventType !== undefined && typeof config.eventType !== 'string') {
      errors.push('eventType must be a string (e.g. "EQ", "TC", "FL")');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const minLevelRaw = config.minLevel ? String(config.minLevel).toLowerCase() : undefined;
    const minLevel =
      minLevelRaw === 'green' || minLevelRaw === 'orange' || minLevelRaw === 'red' ? minLevelRaw : undefined;
    const sourceId = String(config.sourceId ?? 'gdacs');

    const url = new URL(GEOJSON_URL);
    if (typeof config.eventType === 'string') {
      url.searchParams.set('eventlist', config.eventType.toUpperCase());
    }

    const res = await safeFetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`GDACS fetch failed: ${res.status} ${res.statusText}`);
    }

    const payload = (await res.json()) as GdacsPayload;
    return parseGdacs(payload, { sourceId, minLevel, makeEvent: this.makeEvent.bind(this) });
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await safeFetch(GEOJSON_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
