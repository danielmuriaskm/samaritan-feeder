import { query } from '../db.js';
import { bus } from '../bus.js';
import { insertSignal, isSuppressed } from '../store/signals.js';
import type { IntelSignal, SourceKind, EventKind } from '../types.js';

/**
 * Cross-stream convergence (005).
 *
 * Turns N independent polls of the *same* underlying event into ONE scored
 * correlation signal. `nlpCluster` already stamps co-referent events with a
 * shared `tags.cluster_id` — nobody reads it. This processor does: when several
 * *independent kinds of source* (a wire report + a social post + a government
 * hazard feed) land in the same cluster, that corroboration is itself the
 * intelligence.
 *
 * Clean-room note: the IDEA of correlating across heterogeneous streams is
 * inspired by worldmonitor (AGPL-3.0); none of its code, prompts, thresholds or
 * curated tables are used. The source-family taxonomy, cell size, diversity
 * scoring and dedupe scheme below are all original to this MIT module.
 *
 * The detectors are PURE (no DB, no clock side-effects beyond a passed `now`)
 * so they are unit-testable in isolation; `runConvergence()` is the only async
 * shell that reads events and writes signals.
 */

// ---------------------------------------------------------------------------
// Lightweight event record. The detectors operate on this projection only, so
// callers (and tests) need not materialise full IntelligenceEvent rows. Note it
// carries BOTH the event kind (for geo diversity) and the SOURCE kind (for
// family diversity) — the two independence axes the detectors count.
// ---------------------------------------------------------------------------
export interface ConvergenceEvent {
  id: string;
  sourceId: string;
  /** The originating source's kind (rss, usgs, webcam, ...) — drives family diversity. */
  sourceKind: SourceKind;
  /** The event's own kind (text, visual, alert, ...) — drives geo diversity. */
  kind: EventKind;
  /** May carry `cluster_id` (set by nlpCluster) plus arbitrary processor tags. */
  tags: Record<string, unknown>;
  location?: { lat: number; lon: number };
  eventAt: number;
}

// ---------------------------------------------------------------------------
// Source-family taxonomy. Independence is the whole point: three Reddit polls
// of one event are NOT three corroborating sources, but a Reddit post + an RSS
// wire item + a USGS feed are. We collapse the many SourceKinds into a handful
// of *families* and count DISTINCT families, not distinct sources/kinds.
//
// Clean-room: this grouping is our own editorial judgement, not copied.
// ---------------------------------------------------------------------------
export type SourceFamily =
  | 'wire_news' // editorial / press / aggregators
  | 'social' // user-generated social streams
  | 'osint_cyber' // infra / threat-intel / recon
  | 'camera_cv' // physical cameras + computer vision
  | 'hazard_gov' // authoritative hazard / government feeds
  | 'other';

const KIND_FAMILY: Partial<Record<SourceKind, SourceFamily>> = {
  // wire / news
  rss: 'wire_news',
  news_api: 'wire_news',
  gdelt: 'wire_news',
  hn: 'wire_news',
  arxiv: 'wire_news',
  // social
  instagram: 'social',
  twitter: 'social',
  twitter_scrape: 'social',
  reddit: 'social',
  reddit_scrape: 'social',
  bluesky: 'social',
  tiktok: 'social',
  youtube: 'social',
  telegram: 'social',
  discord: 'social',
  // osint / cyber
  github: 'osint_cyber',
  gist: 'osint_cyber',
  shodan: 'osint_cyber',
  censys: 'osint_cyber',
  crtsh: 'osint_cyber',
  virustotal: 'osint_cyber',
  hibp: 'osint_cyber',
  webcrawl: 'osint_cyber',
  sherlock: 'osint_cyber',
  urlscan: 'osint_cyber',
  pastebin: 'osint_cyber',
  darksearch: 'osint_cyber',
  greynoise: 'osint_cyber',
  stix: 'osint_cyber',
  abusech: 'osint_cyber',
  nvd: 'osint_cyber',
  openphish: 'osint_cyber',
  zoneh: 'osint_cyber',
  // camera / computer vision
  webcam: 'camera_cv',
  traffic_cam: 'camera_cv',
  weather_cam: 'camera_cv',
  ip_camera: 'camera_cv',
  // authoritative hazard / government
  windy: 'hazard_gov',
  usgs: 'hazard_gov',
  eonet: 'hazard_gov',
  gdacs: 'hazard_gov',
  nws: 'hazard_gov',
  ngamsi: 'hazard_gov',
  reliefweb: 'hazard_gov',
};

/** Map a source kind to its independence family (defaults to 'other'). */
export function kindToFamily(kind: SourceKind): SourceFamily {
  return KIND_FAMILY[kind] ?? 'other';
}

// ---------------------------------------------------------------------------
// Tunables (clean-room originals, not lifted from any upstream project).
// ---------------------------------------------------------------------------
/** Minimum distinct source families for a source-type convergence to fire. */
export const MIN_FAMILIES = 3;
/** Minimum distinct event kinds co-located in a cell for geo convergence. */
export const MIN_GEO_KINDS = 3;
/** Geo binning granularity in degrees (~111 km per degree of latitude). */
export const GEO_CELL_DEG = 1;
/** A velocity spike fires when current >= this multiple of the rolling baseline. */
export const VELOCITY_MULTIPLE = 3;
/** Time span (ms) within which clustered members must fall to corroborate. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// (a) Source-type convergence: same cluster spanning >= MIN_FAMILIES families.
// ---------------------------------------------------------------------------
export interface SourceConvergence {
  clusterId: string;
  families: SourceFamily[];
  sourceIds: string[];
  eventIds: string[];
  memberCount: number;
  score: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Group events by `tags.cluster_id`; for each cluster spanning at least
 * MIN_FAMILIES distinct source families within `windowMs`, emit a scored
 * convergence. Events with no cluster id (or a non-string one) are ignored —
 * an unclustered event corroborates nothing.
 */
export function detectSourceTypeConvergence(
  events: ConvergenceEvent[],
  opts: { windowMs?: number; minFamilies?: number } = {},
): SourceConvergence[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minFamilies = opts.minFamilies ?? MIN_FAMILIES;

  const byCluster = new Map<string, ConvergenceEvent[]>();
  for (const ev of events) {
    const cid = ev.tags?.cluster_id;
    if (typeof cid !== 'string' || !cid) continue;
    const bucket = byCluster.get(cid);
    if (bucket) bucket.push(ev);
    else byCluster.set(cid, [ev]);
  }

  const out: SourceConvergence[] = [];
  for (const [clusterId, members] of byCluster) {
    if (members.length < minFamilies) continue; // can't span N families with < N members

    // Time-bound the cluster: only members within `windowMs` of the latest one
    // corroborate (a stale member resurfacing months later is not convergence).
    const latest = Math.max(...members.map((m) => m.eventAt));
    const inWindow = members.filter((m) => latest - m.eventAt <= windowMs);
    if (inWindow.length < minFamilies) continue;

    const families = new Set<SourceFamily>();
    const sourceIds = new Set<string>();
    let windowStart = Number.POSITIVE_INFINITY;
    let windowEnd = Number.NEGATIVE_INFINITY;
    for (const m of inWindow) {
      families.add(kindToFamily(m.sourceKind));
      sourceIds.add(m.sourceId);
      if (m.eventAt < windowStart) windowStart = m.eventAt;
      if (m.eventAt > windowEnd) windowEnd = m.eventAt;
    }

    if (families.size < minFamilies) continue;

    out.push({
      clusterId,
      families: [...families].sort(),
      sourceIds: [...sourceIds].sort(),
      eventIds: inWindow.map((m) => m.id).sort(),
      memberCount: inWindow.length,
      score: scoreConvergence(families.size, inWindow.length),
      windowStart,
      windowEnd,
    });
  }
  // Strongest convergence first — useful for callers that cap output.
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Convergence score in 0..1. Two independent axes:
 *   - family/kind diversity (the dominant term — independence is what matters),
 *   - member volume, log-scaled (the 50th poll adds little over the 5th).
 * Diversity is weighted ~2x volume so a 3-family / 3-member cluster outranks a
 * 2-family / 30-member one.
 */
export function scoreConvergence(diversityCount: number, memberCount: number): number {
  // 5 real families -> diversity saturates at 1.
  const diversity = Math.min(1, diversityCount / 5);
  // log2 scaling: 1 member -> 0, 32 members -> 1.
  const volume = Math.min(1, Math.log2(Math.max(1, memberCount)) / 5);
  const raw = 0.7 * diversity + 0.3 * volume;
  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// (b) Geo convergence: a ~1-degree cell where >= MIN_GEO_KINDS distinct EVENT
// KINDS co-occur within 24h. Independence here is by event kind (a 'visual'
// camera hit + a 'text' wire item + an 'alert' hazard feed in one place).
// ---------------------------------------------------------------------------
export interface GeoConvergence {
  cellKey: string;
  center: { lat: number; lon: number };
  kinds: EventKind[];
  sourceIds: string[];
  eventIds: string[];
  memberCount: number;
  score: number;
  windowStart: number;
  windowEnd: number;
}

/** Stable cell key + center for a coordinate at the configured granularity. */
export function geoCell(
  lat: number,
  lon: number,
  cellDeg: number = GEO_CELL_DEG,
): { key: string; center: { lat: number; lon: number } } {
  const latBin = Math.floor(lat / cellDeg);
  const lonBin = Math.floor(lon / cellDeg);
  return {
    key: `${latBin}:${lonBin}`,
    center: {
      lat: (latBin + 0.5) * cellDeg,
      lon: (lonBin + 0.5) * cellDeg,
    },
  };
}

export function detectGeoConvergence(
  events: ConvergenceEvent[],
  opts: { windowMs?: number; minKinds?: number; cellDeg?: number } = {},
): GeoConvergence[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minKinds = opts.minKinds ?? MIN_GEO_KINDS;
  const cellDeg = opts.cellDeg ?? GEO_CELL_DEG;

  const byCell = new Map<string, { center: { lat: number; lon: number }; members: ConvergenceEvent[] }>();
  for (const ev of events) {
    if (!ev.location || !isFinite(ev.location.lat) || !isFinite(ev.location.lon)) continue;
    const { key, center } = geoCell(ev.location.lat, ev.location.lon, cellDeg);
    const bucket = byCell.get(key);
    if (bucket) bucket.members.push(ev);
    else byCell.set(key, { center, members: [ev] });
  }

  const out: GeoConvergence[] = [];
  for (const [cellKey, { center, members }] of byCell) {
    if (members.length < minKinds) continue;

    const latest = Math.max(...members.map((m) => m.eventAt));
    const inWindow = members.filter((m) => latest - m.eventAt <= windowMs);
    if (inWindow.length < minKinds) continue;

    const kinds = new Set<EventKind>();
    const sourceIds = new Set<string>();
    let windowStart = Number.POSITIVE_INFINITY;
    let windowEnd = Number.NEGATIVE_INFINITY;
    for (const m of inWindow) {
      kinds.add(m.kind);
      sourceIds.add(m.sourceId);
      if (m.eventAt < windowStart) windowStart = m.eventAt;
      if (m.eventAt > windowEnd) windowEnd = m.eventAt;
    }

    if (kinds.size < minKinds) continue;

    out.push({
      cellKey,
      center,
      kinds: [...kinds].sort(),
      sourceIds: [...sourceIds].sort(),
      eventIds: inWindow.map((m) => m.id).sort(),
      memberCount: inWindow.length,
      // Reuse the diversity/volume scoring with kind-count as the diversity axis.
      score: scoreConvergence(kinds.size, inWindow.length),
      windowStart,
      windowEnd,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------------------------------------------------------------------
// (c) Velocity spike (simpler): a cluster whose current-window member count is
// >= VELOCITY_MULTIPLE x its rolling baseline. Baseline is supplied by the
// caller (e.g. source_volume_baseline) — the detector stays pure.
// ---------------------------------------------------------------------------
export interface VelocitySpike {
  clusterId: string;
  current: number;
  baseline: number;
  ratio: number;
  score: number;
}

/**
 * `currentCounts`: cluster_id -> events seen in the current window.
 * `baseline(clusterId)`: that cluster's expected per-window count (>0 to fire).
 */
export function detectVelocitySpike(
  currentCounts: Map<string, number>,
  baseline: (clusterId: string) => number,
  opts: { multiple?: number; minCurrent?: number } = {},
): VelocitySpike[] {
  const multiple = opts.multiple ?? VELOCITY_MULTIPLE;
  // Require a few absolute hits so a 1 -> 4 blip on a near-silent cluster doesn't fire.
  const minCurrent = opts.minCurrent ?? multiple;

  const out: VelocitySpike[] = [];
  for (const [clusterId, current] of currentCounts) {
    if (current < minCurrent) continue;
    const base = baseline(clusterId);
    if (!(base > 0)) continue; // no usable baseline -> can't call it a spike
    const ratio = current / base;
    if (ratio < multiple) continue;
    out.push({
      clusterId,
      current,
      baseline: base,
      ratio,
      // Map ratio above threshold onto 0.5..1 (3x -> 0.5, >=9x -> 1).
      score: clamp01(0.5 + ((ratio - multiple) / (multiple * 2)) * 0.5),
    });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

// ---------------------------------------------------------------------------
// (d) Rarity outliers: bucket recent events along an axis (source family, event
// kind, or country) and flag buckets whose share of the total is vanishingly
// small. The intuition: in a firehose, the *rare* category is the interesting
// one — one phishing-feed hit among 2000 wire items is worth a look.
//
// Clean-room: idea inspired by SpiderFoot's analysis_outlier rarity analyzer
// (smicallef/spiderfoot, MIT); thresholds, axes, guards and scoring are ours.
// ---------------------------------------------------------------------------
export type OutlierAxis = 'family' | 'kind' | 'country';

export interface Outlier {
  axis: OutlierAxis;
  bucketKey: string;
  count: number;
  total: number;
  share: number;
  score: number;
}

/** Project an event onto the requested outlier axis (null = no value, skip). */
function outlierBucketKey(ev: ConvergenceEvent, axis: OutlierAxis): string | null {
  if (axis === 'family') return kindToFamily(ev.sourceKind);
  if (axis === 'kind') return ev.kind;
  const country = ev.tags?.country;
  return typeof country === 'string' && country ? country : null;
}

/**
 * Flag rare buckets. For each axis we count members per bucket; a bucket is an
 * outlier when its share <= `maximumPercent` (default 0.10). Two guards stop us
 * crying wolf on thin or already-flat data: if `total` < `minTotal` (default 20)
 * there isn't enough signal, and if the *average* bucket share is itself below
 * `noisyPercent` (default 0.05) the axis is so fragmented that "rare" is the
 * norm — return nothing rather than flag everything.
 */
export function detectOutliers(
  events: ConvergenceEvent[],
  opts: {
    axes?: OutlierAxis[];
    maximumPercent?: number;
    noisyPercent?: number;
    minTotal?: number;
  } = {},
): Outlier[] {
  const axes = opts.axes ?? (['family', 'kind', 'country'] as OutlierAxis[]);
  const maximumPercent = opts.maximumPercent ?? 0.1;
  const noisyPercent = opts.noisyPercent ?? 0.05;
  const minTotal = opts.minTotal ?? 20;

  const out: Outlier[] = [];
  for (const axis of axes) {
    const counts = new Map<string, number>();
    for (const ev of events) {
      const key = outlierBucketKey(ev, axis);
      if (key == null) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let total = 0;
    for (const c of counts.values()) total += c;
    if (total < minTotal || counts.size === 0) continue;
    // Noisy-data guard: a tiny mean share means the axis is already uniform/noisy.
    const avgShare = 1 / counts.size;
    if (avgShare < noisyPercent) continue;
    for (const [bucketKey, count] of counts) {
      const share = count / total;
      if (share > maximumPercent) continue;
      // Rarer -> higher; blend the linear rarity term with a small volume floor
      // so a singleton bucket doesn't outscore a small-but-corroborated one.
      const rarity = clamp01((maximumPercent - share) / maximumPercent);
      const volume = clamp01(Math.log2(Math.max(1, count)) / 5);
      out.push({ axis, bucketKey, count, total, share, score: clamp01(0.8 * rarity + 0.2 * volume) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------------------------------------------------------------------
// (e) Single-family-only clusters: a set-difference triage flag. A cluster
// whose member source-families are wholly inside `only` (default {'social'})
// and never touch `absentFrom` (default {'wire_news','hazard_gov'}) was
// reported by ONE kind of source and never corroborated by wire/gov — a soft
// credibility / disinfo signal, NOT an alert. Scores stay deliberately low.
//
// Clean-room: idea inspired by SpiderFoot's analysis_first_collection_only
// set-difference analyzer (smicallef/spiderfoot, MIT); grouping, families and
// scoring are ours.
// ---------------------------------------------------------------------------
export interface SingleFamilyCluster {
  clusterId: string;
  families: SourceFamily[];
  eventIds: string[];
  sourceIds: string[];
  memberCount: number;
  score: number;
}

export function detectSingleFamilyOnly(
  events: ConvergenceEvent[],
  opts: {
    windowMs?: number;
    only?: Set<SourceFamily>;
    absentFrom?: Set<SourceFamily>;
    /** Minimum in-window members before a single-family cluster is worth flagging.
     *  Without a floor every lone social post (with a cluster id) would fire — pure
     *  noise. A meaningful "uncorroborated" cluster needs corroboration WITHIN the
     *  family first, then the cross-family absence is the signal. */
    minMembers?: number;
  } = {},
): SingleFamilyCluster[] {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const only = opts.only ?? new Set<SourceFamily>(['social']);
  const absentFrom = opts.absentFrom ?? new Set<SourceFamily>(['wire_news', 'hazard_gov']);
  const minMembers = opts.minMembers ?? 3;

  const byCluster = new Map<string, ConvergenceEvent[]>();
  for (const ev of events) {
    const cid = ev.tags?.cluster_id;
    if (typeof cid !== 'string' || !cid) continue;
    const bucket = byCluster.get(cid);
    if (bucket) bucket.push(ev);
    else byCluster.set(cid, [ev]);
  }

  const out: SingleFamilyCluster[] = [];
  for (const [clusterId, members] of byCluster) {
    // Time-bound the cluster, mirroring detectSourceTypeConvergence.
    const latest = Math.max(...members.map((m) => m.eventAt));
    const inWindow = members.filter((m) => latest - m.eventAt <= windowMs);
    // A lone (or near-lone) cluster corroborates nothing — require a real
    // intra-family cluster before flagging it as conspicuously uncorroborated.
    if (inWindow.length < minMembers) continue;

    const families = new Set<SourceFamily>();
    const sourceIds = new Set<string>();
    for (const m of inWindow) {
      families.add(kindToFamily(m.sourceKind));
      sourceIds.add(m.sourceId);
    }
    // Subset of `only` AND disjoint from `absentFrom`.
    let ok = true;
    for (const f of families) {
      if (!only.has(f) || absentFrom.has(f)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    out.push({
      clusterId,
      families: [...families].sort(),
      eventIds: inWindow.map((m) => m.id).sort(),
      sourceIds: [...sourceIds].sort(),
      memberCount: inWindow.length,
      // Triage flag, not an alert: hold the score in a low 0.3..0.5 band,
      // rising gently with corroboration *within* the single family.
      score: clamp01(0.3 + Math.min(1, Math.log2(Math.max(1, inWindow.length)) / 5) * 0.2),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrator: read recent events, run detectors, persist NEW firings.
// ---------------------------------------------------------------------------
const RECENT_EVENT_LIMIT = 4000;

/** Row shape from the raw cluster_id + source-kind join. */
interface EventRow extends Record<string, unknown> {
  id: string;
  source_id: string;
  source_kind: string | null;
  kind: string;
  tags: unknown;
  location_lat: number | string | null;
  location_lon: number | string | null;
  event_at: number | string;
}

/**
 * Load lightweight event projections for the lookback window. We read the raw
 * column set (not listEvents) so the cluster id — written via jsonb_set by
 * nlpCluster — and the originating source's KIND (joined from
 * intelligence_sources) both come back without materialising full rows.
 */
export async function loadRecentConvergenceEvents(sinceMs: number): Promise<ConvergenceEvent[]> {
  const rows = await query<EventRow>(
    `SELECT e.id, e.source_id, s.kind AS source_kind, e.kind, e.tags,
            e.location_lat, e.location_lon, e.event_at
       FROM intelligence_events e
       LEFT JOIN intelligence_sources s ON s.id = e.source_id
      WHERE e.event_at >= $1
      ORDER BY e.event_at DESC
      LIMIT $2`,
    [sinceMs, RECENT_EVENT_LIMIT],
  );
  return rows.map(rowToConvergenceEvent);
}

function rowToConvergenceEvent(row: EventRow): ConvergenceEvent {
  const tags =
    row.tags == null
      ? {}
      : typeof row.tags === 'string'
        ? safeJson(row.tags)
        : (row.tags as Record<string, unknown>);
  const lat = row.location_lat != null ? Number(row.location_lat) : undefined;
  const lon = row.location_lon != null ? Number(row.location_lon) : undefined;
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    // A source row may have been deleted; fall back to a harmless 'other' family.
    sourceKind: (row.source_kind ?? 'rss') as SourceKind,
    kind: row.kind as EventKind,
    tags,
    location:
      lat != null && lon != null && isFinite(lat) && isFinite(lon) ? { lat, lon } : undefined,
    eventAt: Number(row.event_at),
  };
}

export interface RunConvergenceOptions {
  /** Lookback window (ms). Defaults to 24h. */
  windowMs?: number;
  /** Anti-spam: re-fire the same dedupe key only after this many ms. Defaults to windowMs. */
  dedupeWindowMs?: number;
  /** Injectable clock for testing. */
  now?: number;
  /** Injectable event loader (defaults to the DB read). */
  load?: (sinceMs: number) => Promise<ConvergenceEvent[]>;
}

export interface RunConvergenceResult {
  scanned: number;
  fired: number;
  signals: IntelSignal[];
}

/**
 * Read recent events, run the source-type and geo detectors, and for each NEW
 * firing (deduped on a composed key within `dedupeWindowMs`) insert a signal
 * and emit it on the bus. Default posture is signals-only — no kind:'alert'
 * events are written, keeping the delivery surface opt-in for the integrator.
 */
export async function runConvergence(opts: RunConvergenceOptions = {}): Promise<RunConvergenceResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const dedupeWindowMs = opts.dedupeWindowMs ?? windowMs;
  const load = opts.load ?? loadRecentConvergenceEvents;

  const events = await load(now - windowMs);
  const dedupeSince = now - dedupeWindowMs;
  const fired: IntelSignal[] = [];

  const sourceConvs = detectSourceTypeConvergence(events, { windowMs });
  for (const conv of sourceConvs) {
    const dedupeKey = `conv:cluster:${conv.clusterId}:fam:${conv.families.join('+')}`;
    if (await isSuppressed(dedupeKey, dedupeSince, now)) continue;
    const sig = await insertSignal({
      kind: 'convergence',
      score: conv.score,
      title: `Cross-stream convergence: ${conv.families.length} source families`,
      summary: `${conv.memberCount} reports across ${conv.families.join(', ')} converged on one cluster`,
      clusterId: conv.clusterId,
      sourceIds: conv.sourceIds,
      eventIds: conv.eventIds,
      windowStart: conv.windowStart,
      windowEnd: conv.windowEnd,
      dedupeKey,
      metadata: { families: conv.families, memberCount: conv.memberCount },
      createdAt: now,
    });
    bus.emitSignal(sig);
    fired.push(sig);
  }

  const geoConvs = detectGeoConvergence(events, { windowMs });
  for (const geo of geoConvs) {
    const dedupeKey = `geoconv:cell:${geo.cellKey}:kinds:${geo.kinds.join('+')}`;
    if (await isSuppressed(dedupeKey, dedupeSince, now)) continue;
    const sig = await insertSignal({
      kind: 'geo_convergence',
      score: geo.score,
      title: `Geo convergence near ${geo.center.lat.toFixed(1)}, ${geo.center.lon.toFixed(1)}`,
      summary: `${geo.memberCount} events of kinds ${geo.kinds.join(', ')} co-located in one ~${GEO_CELL_DEG}-degree cell`,
      sourceIds: geo.sourceIds,
      eventIds: geo.eventIds,
      location: geo.center,
      windowStart: geo.windowStart,
      windowEnd: geo.windowEnd,
      dedupeKey,
      metadata: { kinds: geo.kinds, cellKey: geo.cellKey, memberCount: geo.memberCount },
      createdAt: now,
    });
    bus.emitSignal(sig);
    fired.push(sig);
  }

  const outliers = detectOutliers(events);
  for (const o of outliers) {
    const dedupeKey = `outlier:${o.axis}:${o.bucketKey}`;
    if (await isSuppressed(dedupeKey, dedupeSince, now)) continue;
    const sharePct = (o.share * 100).toFixed(1);
    const sig = await insertSignal({
      kind: 'outlier',
      score: o.score,
      title: `Rare ${o.axis}: ${o.bucketKey} (${sharePct}% of stream)`,
      summary: `${o.count} of ${o.total} recent events fall in ${o.axis} "${o.bucketKey}" — a ${sharePct}% share`,
      dedupeKey,
      metadata: {
        axis: o.axis,
        bucketKey: o.bucketKey,
        count: o.count,
        total: o.total,
        share: o.share,
      },
      createdAt: now,
    });
    bus.emitSignal(sig);
    fired.push(sig);
  }

  const uncorroborated = detectSingleFamilyOnly(events, { windowMs });
  for (const u of uncorroborated) {
    const dedupeKey = `uncorr:cluster:${u.clusterId}`;
    if (await isSuppressed(dedupeKey, dedupeSince, now)) continue;
    const sig = await insertSignal({
      kind: 'uncorroborated',
      score: u.score,
      title: `Uncorroborated cluster: ${u.families.join(', ')} only`,
      summary: `${u.memberCount} reports in one cluster came only from ${u.families.join(', ')} — never corroborated by wire/gov`,
      clusterId: u.clusterId,
      sourceIds: u.sourceIds,
      eventIds: u.eventIds,
      dedupeKey,
      metadata: { families: u.families, memberCount: u.memberCount },
      createdAt: now,
    });
    bus.emitSignal(sig);
    fired.push(sig);
  }

  if (fired.length) {
    console.log(
      `[convergence] ${fired.length} new signal(s) from ${events.length} events ` +
        `(${sourceConvs.length} source-conv, ${geoConvs.length} geo-conv, ` +
        `${outliers.length} outlier, ${uncorroborated.length} uncorroborated detected)`,
    );
  }
  return { scanned: events.length, fired: fired.length, signals: fired };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clamp01(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
