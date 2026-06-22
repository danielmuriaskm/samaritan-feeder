// Typed client for the feeder HTTP API. The Vite dev proxy maps /api -> the feeder
// (see vite.config.ts); in production the feeder serves this SPA from web/dist and
// the same /api paths resolve to its routes.
import type { Brief, Channel, ChannelKind, IntelEvent, IntelSignal, Source } from './types.js';

const BASE = '/api';

async function getJSON<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function sendJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// ---- Events ----
export interface EventQuery {
  rank?: 'recency' | 'score';
  query?: string;
  kinds?: string[];
  sourceId?: string;
  since?: number;
  minScore?: number;
  limit?: number;
}
export async function getEvents(q: EventQuery = {}): Promise<IntelEvent[]> {
  const data = await getJSON<{ events: IntelEvent[] }>('/events', {
    rank: q.rank,
    query: q.query,
    kinds: q.kinds?.length ? q.kinds.join(',') : undefined,
    sourceId: q.sourceId,
    since: q.since,
    minScore: q.minScore,
    limit: q.limit ?? 100,
  });
  return data.events ?? [];
}

// ---- Sources (incl. health) ----
export async function getSources(): Promise<Source[]> {
  const data = await getJSON<{ sources: Source[] }>('/sources');
  return data.sources ?? [];
}

// ---- Signals (convergence / freshness) ----
export interface SignalQuery {
  kinds?: string[];
  since?: number;
  minScore?: number;
  limit?: number;
}
export async function getSignals(q: SignalQuery = {}): Promise<IntelSignal[]> {
  const data = await getJSON<{ signals: IntelSignal[] }>('/signals', {
    kinds: q.kinds?.length ? q.kinds.join(',') : undefined,
    since: q.since,
    minScore: q.minScore,
    limit: q.limit ?? 100,
  });
  return data.signals ?? [];
}

// ---- Briefs ----
export async function getBrief(userId: string): Promise<Brief | null> {
  const data = await getJSON<{ brief: Brief | null }>(`/brief/${encodeURIComponent(userId)}`);
  return data.brief ?? null;
}

// ---- Delivery channels ----
export async function listChannels(userId: string, enabledOnly = false): Promise<Channel[]> {
  const data = await getJSON<{ channels: Channel[] }>('/channels', { userId, enabledOnly: enabledOnly ? 'true' : undefined });
  return data.channels ?? [];
}
export async function createChannel(input: {
  userId: string;
  kind: ChannelKind;
  config: Record<string, unknown>;
  enabled?: boolean;
  quietHours?: { tz?: string; startHour: number; endHour: number };
}): Promise<Channel> {
  return sendJSON<Channel>('POST', '/channels', input);
}
export async function setChannelEnabled(id: string, enabled: boolean): Promise<void> {
  await sendJSON('PATCH', `/channels/${encodeURIComponent(id)}`, { enabled });
}
export async function deleteChannel(id: string): Promise<void> {
  await sendJSON('DELETE', `/channels/${encodeURIComponent(id)}`);
}

// ---- Live radar layers (ADS-B aircraft, AIS ships, camera markers) ----
// These are on-demand current positions for the visible map view, fetched per
// bbox (NOT ingested events). bbox is "minLat,minLon,maxLat,maxLon".
export interface Aircraft {
  id: string;
  lat: number;
  lon: number;
  heading: number | null;
  alt: number | null;
  speed: number | null;
  callsign: string | null;
  type: string | null;
}
export interface Ship {
  id: string;
  lat: number;
  lon: number;
  heading: number | null;
  speed: number | null;
  name: string | null;
  type: string | null;
}
export interface CameraMarker {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  country: string;
  region?: string;
  provider?: string;
  streamUrl?: string | null;
  infoUrl?: string | null;
  streamType?: string | null;
}

export async function getAircraft(bbox: string, limit?: number): Promise<Aircraft[]> {
  const data = await getJSON<{ aircraft: Aircraft[] }>('/radar/aircraft', { bbox, limit });
  return data.aircraft ?? [];
}
export async function getShips(bbox: string, limit?: number): Promise<Ship[]> {
  const data = await getJSON<{ ships: Ship[] }>('/radar/ships', { bbox, limit });
  return data.ships ?? [];
}
export async function getCameraMarkers(bbox: string, limit?: number): Promise<CameraMarker[]> {
  const data = await getJSON<{ markers: CameraMarker[] }>('/cameras/markers', { bbox, limit });
  return data.markers ?? [];
}

// ---- Discover (LLM-synthesized, Perplexity-style topic tiles) ----
export interface DiscoverSource { sourceId: string; kind?: string; count?: number }
export interface DiscoverTile {
  id: string;
  title: string;
  summary: string;
  category: string;
  sources: DiscoverSource[];
  eventIds: string[];
  score: number;
  updatedAt: number;
  generatedBy?: 'llm' | 'deterministic';
}
export interface DiscoverStats { tiles: number; eventsConsidered: number; lastRefresh: number; model?: string }

export async function getDiscover(limit?: number): Promise<DiscoverTile[]> {
  const data = await getJSON<{ tiles: DiscoverTile[] }>('/discover', { limit });
  return data.tiles ?? [];
}
export async function getDiscoverStats(): Promise<DiscoverStats | null> {
  try {
    return await getJSON<DiscoverStats>('/discover/stats');
  } catch {
    return null;
  }
}

// ---- Live stream URL (for EventSource) ----
export function streamUrl(userId: string, opts: { minScore?: number; kinds?: string[]; sourceId?: string } = {}): string {
  const url = new URL(`${BASE}/stream/${encodeURIComponent(userId)}`, window.location.origin);
  if (opts.minScore !== undefined) url.searchParams.set('minScore', String(opts.minScore));
  if (opts.kinds?.length) url.searchParams.set('kinds', opts.kinds.join(','));
  if (opts.sourceId) url.searchParams.set('sourceId', opts.sourceId);
  return url.toString();
}
