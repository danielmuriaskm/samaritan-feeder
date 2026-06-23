// Typed client for the feeder HTTP API. The Vite dev proxy maps /api -> the feeder
// (see vite.config.ts); in production the feeder serves this SPA from web/dist and
// the same /api paths resolve to its routes.
import type {
  AoiRule, Brief, Channel, ChannelKind, CvAlertRow, DataClass, IntelEvent, IntelSignal,
  RiskBand, SignalMute, Source, Subscription, TriageState,
} from './types.js';

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
  mode?: 'contains' | 'wildcard' | 'regex';
  kinds?: string[];
  sourceId?: string;
  since?: number;
  until?: number;
  minScore?: number;
  dataClass?: DataClass;
  riskBand?: RiskBand;
  limit?: number;
}
function eventParams(q: EventQuery): Record<string, string | number | undefined> {
  return {
    rank: q.rank,
    query: q.query,
    mode: q.mode,
    kinds: q.kinds?.length ? q.kinds.join(',') : undefined,
    sourceId: q.sourceId,
    since: q.since,
    until: q.until,
    minScore: q.minScore,
    dataClass: q.dataClass,
    riskBand: q.riskBand,
    limit: q.limit ?? 100,
  };
}
export async function getEvents(q: EventQuery = {}): Promise<IntelEvent[]> {
  const data = await getJSON<{ events: IntelEvent[] }>('/events', eventParams(q));
  return data.events ?? [];
}
/** Build a download URL for the CSV/NDJSON export of an events query (006). */
export function eventsExportUrl(q: EventQuery, format: 'csv' | 'ndjson'): string {
  const url = new URL(BASE + '/events', window.location.origin);
  url.searchParams.set('format', format);
  for (const [k, v] of Object.entries(eventParams(q))) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}
export async function getEvent(id: string): Promise<IntelEvent | null> {
  try { return await getJSON<IntelEvent>(`/events/${encodeURIComponent(id)}`); } catch { return null; }
}

// ---- Data-class / risk-band option lists (mirror the server enums) ----
export const DATA_CLASSES: DataClass[] = [
  'hazard_alert', 'cyber_ioc', 'vulnerability', 'breach_leak', 'leaked_secret',
  'exposed_service', 'malware', 'phishing', 'defacement', 'recon_finding',
  'cv_detection', 'social_post', 'news', 'research', 'other',
];
export const RISK_BANDS: RiskBand[] = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];

// ---- Sources (incl. health) ----
export async function getSources(): Promise<Source[]> {
  const data = await getJSON<{ sources: Source[] }>('/sources');
  return data.sources ?? [];
}

// ---- Signals (convergence / freshness / outlier / rule_match) + 006 triage ----
export interface SignalQuery {
  kinds?: string[];
  since?: number;
  minScore?: number;
  limit?: number;
  /** 006: include operator-dismissed signals (default hides them). */
  includeDismissed?: boolean;
}
export async function getSignals(q: SignalQuery = {}): Promise<IntelSignal[]> {
  const data = await getJSON<{ signals: IntelSignal[] }>('/signals', {
    kinds: q.kinds?.length ? q.kinds.join(',') : undefined,
    since: q.since,
    minScore: q.minScore,
    limit: q.limit ?? 100,
    includeDismissed: q.includeDismissed ? 'true' : undefined,
  });
  return data.signals ?? [];
}
/** 006: a signal + the member events behind it (drill-down). */
export async function getSignal(id: string): Promise<{ signal: IntelSignal; events: IntelEvent[] }> {
  return getJSON<{ signal: IntelSignal; events: IntelEvent[] }>(`/signals/${encodeURIComponent(id)}`);
}
export async function setSignalTriage(id: string, state: TriageState): Promise<void> {
  await sendJSON('PATCH', `/signals/${encodeURIComponent(id)}/triage`, { state });
}
export async function muteSignal(id: string, mutedUntil?: number | null, reason?: string): Promise<void> {
  await sendJSON('POST', `/signals/${encodeURIComponent(id)}/mute`, { mutedUntil: mutedUntil ?? null, reason });
}
export async function unmuteSignal(id: string): Promise<void> {
  await sendJSON('DELETE', `/signals/${encodeURIComponent(id)}/mute`);
}
/** Unmute directly by dedupe key (used by the muted-keys list, which has no signal id). */
export async function unmuteKey(dedupeKey: string): Promise<void> {
  await sendJSON('DELETE', `/signals/mutes/${encodeURIComponent(dedupeKey)}`);
}
export async function listSignalMutes(): Promise<SignalMute[]> {
  const data = await getJSON<{ mutes: SignalMute[] }>('/signals/mutes');
  return data.mutes ?? [];
}

// ---- Area of Interest (006) ----
export async function listAoi(enabledOnly = false): Promise<AoiRule[]> {
  const data = await getJSON<{ aoi: AoiRule[] }>('/aoi', { enabledOnly: enabledOnly ? 'true' : undefined });
  return data.aoi ?? [];
}
export async function createAoi(input: { name: string; kind: AoiRule['kind']; definition: Record<string, unknown>; weight?: number; enabled?: boolean }): Promise<AoiRule> {
  return sendJSON<AoiRule>('POST', '/aoi', input);
}
export async function setAoiEnabled(id: string, enabled: boolean): Promise<void> {
  await sendJSON('PATCH', `/aoi/${encodeURIComponent(id)}`, { enabled });
}
export async function deleteAoi(id: string): Promise<void> {
  await sendJSON('DELETE', `/aoi/${encodeURIComponent(id)}`);
}

// ---- Graph (006 export + lineage + entity-tier) ----
export interface GraphOpts { limit?: number; tier?: 'entity'; includeLineage?: boolean }
export async function getGraphNetwork(opts: GraphOpts = {}): Promise<{ nodes: unknown[]; links: unknown[] }> {
  return getJSON<{ nodes: unknown[]; links: unknown[] }>('/graph/network', {
    limit: opts.limit ?? 100,
    tier: opts.tier,
    includeLineage: opts.includeLineage ? 'true' : undefined,
  });
}
export interface LineageNeighbor { eventId: string; relation: string; processor?: string; title?: string; kind?: string; eventAt?: number }
export async function getLineage(eventId: string): Promise<{ parents: LineageNeighbor[]; children: LineageNeighbor[] }> {
  return getJSON<{ parents: LineageNeighbor[]; children: LineageNeighbor[] }>(`/graph/lineage/${encodeURIComponent(eventId)}`);
}
/** Download URL for the graph export (gexf/sigma/tree). tree requires root. */
export function graphExportUrl(format: 'gexf' | 'sigma' | 'tree', opts: GraphOpts & { root?: string; maxDepth?: number } = {}): string {
  const url = new URL(BASE + '/graph/network', window.location.origin);
  url.searchParams.set('format', format);
  if (opts.limit) url.searchParams.set('limit', String(opts.limit));
  if (opts.tier) url.searchParams.set('tier', opts.tier);
  if (opts.includeLineage) url.searchParams.set('includeLineage', 'true');
  if (opts.root) url.searchParams.set('root', opts.root);
  if (opts.maxDepth) url.searchParams.set('maxDepth', String(opts.maxDepth));
  return url.toString();
}

// ---- Dashboard (incl. 006 riskMatrix) ----
export interface DashboardPayload {
  events?: { riskMatrix?: { counts?: Record<string, number>; bands?: { band: string; count: number }[]; window?: string }; [k: string]: unknown };
  [k: string]: unknown;
}
export async function getDashboard(): Promise<DashboardPayload> {
  return getJSON<DashboardPayload>('/dashboard');
}

// ---- Subscriptions (per-source delivery prefs) ----
export async function listSubscriptions(userId: string): Promise<Subscription[]> {
  const data = await getJSON<{ subscriptions: Subscription[] }>('/subscriptions', { userId });
  return data.subscriptions ?? [];
}
export async function createSubscription(input: {
  userId: string; sourceId: string; deliveryMode: Subscription['deliveryMode'];
  minConfidence?: number; filterQuery?: string; allowedKinds?: string[];
}): Promise<Subscription> {
  return sendJSON<Subscription>('POST', '/subscriptions', input);
}
export async function deleteSubscription(id: string): Promise<void> {
  await sendJSON('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
}

// ---- CV (computer-vision sidecar reads) ----
export async function getCvAlerts(sourceId: string, limit?: number): Promise<CvAlertRow[]> {
  const data = await getJSON<{ alerts?: CvAlertRow[] }>(`/cv/alerts/${encodeURIComponent(sourceId)}`, { limit });
  return data.alerts ?? [];
}
export async function getCvDetail(sourceId: string): Promise<unknown> {
  return getJSON<unknown>(`/cv/detail/${encodeURIComponent(sourceId)}`);
}
export async function cvSearch(query: string, limit?: number): Promise<CvAlertRow[]> {
  // The route reads ?q= (src/routes/cv.ts), not ?query=.
  const data = await getJSON<{ results?: CvAlertRow[]; alerts?: CvAlertRow[] }>('/cv/search', { q: query, limit });
  return data.results ?? data.alerts ?? [];
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
