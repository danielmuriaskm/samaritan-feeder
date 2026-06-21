import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

/**
 * USGS earthquake feed adapter.
 *
 * Clean-room: the only thing borrowed from worldmonitor is the *idea* of polling
 * the public USGS GeoJSON summary feeds. The endpoint shape, GeoJSON Feature
 * structure, and field names below are facts published by USGS
 * (https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). No upstream
 * code, strings, or curated tables are copied.
 *
 * Feeds are named `{magnitude}_{window}`, e.g. `4.5_day`, `2.5_week`,
 * `significant_month`, `all_hour`. Default is `4.5_day` (notable quakes, one day).
 */

const FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
const DEFAULT_FEED = '4.5_day';
const MAX_EVENTS = 50;
const VALID_FEED = /^[a-z0-9._]+$/i;

/**
 * Builder signature matching `BaseAdapter#makeEvent` (its `protected` member is
 * not nameable from a free function, so we type the seam structurally). The
 * adapter passes `this.makeEvent.bind(this)`; tests pass a plain stub.
 */
export type MakeEvent = (
  partial: Omit<RawEvent, 'sourceId'> & { sourceId?: string },
  sourceId: string,
) => RawEvent;

/** A single GeoJSON Feature from a USGS feed (only the fields we read). */
interface UsgsFeature {
  id?: string;
  properties?: {
    mag?: number | null;
    place?: string | null;
    time?: number | null; // epoch ms
    updated?: number | null;
    url?: string | null;
    tsunami?: number | null;
    alert?: string | null; // green/yellow/orange/red PAGER alert
    title?: string | null;
    type?: string | null; // 'earthquake', 'quarry blast', ...
  };
  geometry?: {
    type?: string;
    // GeoJSON order: [lon, lat, depth_km]
    coordinates?: Array<number | null>;
  };
}

interface UsgsFeedPayload {
  features?: UsgsFeature[];
}

/**
 * Map a magnitude to a 0..1 confidence. Anything M>=7 is treated as essentially
 * certain to matter; below M2 fades toward the adapter floor. Thresholds are our
 * own choice, not copied from any source.
 */
export function magnitudeConfidence(mag: number | null | undefined): number {
  if (typeof mag !== 'number' || Number.isNaN(mag)) return 0.5;
  if (mag >= 7) return 0.98;
  if (mag >= 6) return 0.92;
  if (mag >= 5) return 0.85;
  if (mag >= 4.5) return 0.78;
  if (mag >= 3) return 0.65;
  return 0.5;
}

/**
 * Pure parser: GeoJSON payload -> RawEvent[]. Exported for unit testing without
 * any network. `minMagnitude` drops smaller quakes even if the feed includes
 * them (e.g. when an operator points at `all_hour`).
 */
export function parseUsgs(
  payload: UsgsFeedPayload,
  opts: { sourceId: string; minMagnitude?: number; max?: number; makeEvent: MakeEvent },
): RawEvent[] {
  const { sourceId, minMagnitude, makeEvent } = opts;
  const max = opts.max ?? MAX_EVENTS;
  const features = Array.isArray(payload.features) ? payload.features : [];
  const events: RawEvent[] = [];

  for (const f of features) {
    if (events.length >= max) break;
    const props = f.properties ?? {};
    const coords = f.geometry?.coordinates ?? [];
    const lon = typeof coords[0] === 'number' ? coords[0] : undefined;
    const lat = typeof coords[1] === 'number' ? coords[1] : undefined;
    const depth = typeof coords[2] === 'number' ? coords[2] : undefined;
    const mag = typeof props.mag === 'number' ? props.mag : undefined;

    if (typeof minMagnitude === 'number' && (mag === undefined || mag < minMagnitude)) continue;

    const place = props.place ?? 'unknown location';
    const magStr = mag !== undefined ? `M${mag.toFixed(1)}` : 'M?';
    const usgsId = f.id ?? props.url ?? `${lat},${lon},${props.time}`;
    const eventAt = typeof props.time === 'number' ? props.time : Date.now();

    const contentLines = [
      `${magStr} earthquake — ${place}`,
      depth !== undefined ? `Depth: ${depth.toFixed(1)} km` : '',
      props.alert ? `PAGER alert: ${String(props.alert).toUpperCase()}` : '',
      props.tsunami ? 'Tsunami flag: yes' : '',
      props.url ? `Details: ${props.url}` : '',
    ].filter(Boolean);

    events.push(
      makeEvent(
        {
          kind: 'anomaly',
          title: `${magStr} — ${place}`,
          content: contentLines.join('\n'),
          eventAt,
          confidence: magnitudeConfidence(mag),
          location: lat !== undefined && lon !== undefined ? { lat, lon } : undefined,
          // Stable upstream id -> re-polls of the same quake collapse to one event.
          dedupeContent: `usgs:${usgsId}`,
          tags: {
            usgs_id: f.id,
            magnitude: mag,
            depth_km: depth,
            place,
            pager_alert: props.alert ?? undefined,
            tsunami: props.tsunami ? true : undefined,
            quake_type: props.type ?? undefined,
            url: props.url ?? undefined,
          },
          rawData: f as Record<string, unknown>,
        },
        sourceId,
      ),
    );
  }

  return events;
}

export class UsgsAdapter extends BaseAdapter {
  readonly kind = 'usgs' as const;
  readonly name = 'USGS Earthquakes';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.feed !== undefined) {
      if (typeof config.feed !== 'string' || !VALID_FEED.test(config.feed)) {
        errors.push('feed must be a feed name like "4.5_day" or "significant_week"');
      }
    }
    if (config.minMagnitude !== undefined && typeof config.minMagnitude !== 'number') {
      errors.push('minMagnitude must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const feed = typeof config.feed === 'string' && VALID_FEED.test(config.feed) ? config.feed : DEFAULT_FEED;
    const minMagnitude = typeof config.minMagnitude === 'number' ? config.minMagnitude : undefined;
    const sourceId = String(config.sourceId ?? `usgs_${feed}`);

    const res = await safeFetch(`${FEED_BASE}/${feed}.geojson`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`USGS feed fetch failed: ${res.status} ${res.statusText}`);
    }

    const payload = (await res.json()) as UsgsFeedPayload;
    return parseUsgs(payload, { sourceId, minMagnitude, makeEvent: this.makeEvent.bind(this) });
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const feed = typeof config.feed === 'string' && VALID_FEED.test(config.feed) ? config.feed : DEFAULT_FEED;
    const start = performance.now();
    try {
      const res = await safeFetch(`${FEED_BASE}/${feed}.geojson`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(8000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
