export type SourceKind =
  | 'instagram'
  | 'twitter'
  | 'reddit'
  | 'bluesky'
  | 'tiktok'
  | 'webcam'
  | 'traffic_cam'
  | 'weather_cam'
  | 'ip_camera'
  | 'rss'
  | 'news_api'
  | 'gdelt'
  | 'github'
  | 'hn'
  | 'arxiv'
  | 'windy'
  | 'youtube'
  | 'telegram'
  | 'discord'
  | 'shodan'
  | 'censys'
  | 'crtsh'
  | 'virustotal'
  | 'hibp'
  | 'webcrawl'
  | 'twitter_scrape'
  | 'reddit_scrape'
  | 'sherlock'
  | 'urlscan'
  | 'pastebin'
  | 'gist'
  | 'darksearch'
  | 'greynoise'
  | 'stix'
  // Structured authoritative feeds (free, mostly keyless) — see src/adapters
  | 'usgs'
  | 'eonet'
  | 'gdacs'
  | 'nws'
  | 'abusech'
  | 'ngamsi'
  | 'reliefweb';

export type EventKind = 'visual' | 'text' | 'anomaly' | 'trend' | 'alert' | 'social_post' | 'detection';

export type DeliveryMode = 'passive' | 'proactive' | 'alert';

export type Sensitivity = 'public' | 'normal' | 'private';

export interface SourceConfig {
  id: string;
  kind: SourceKind;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  enabled: boolean;
  pollIntervalSeconds: number;
  lastPolledAt?: number;
  lastEventAt?: number;
  errorCount: number;
  lastError?: string;
  createdByUserId?: string;
  createdAt: number;
  updatedAt: number;
  // --- 005: source health + circuit breaker ---
  consecutiveFailures?: number;
  cooldownUntil?: number;
  lastLatencyMs?: number;
  healthState?: SourceHealthState;
}

export type SourceHealthState = 'healthy' | 'degraded' | 'silent' | 'failing' | 'cooldown';

export interface RawEvent {
  sourceId: string;
  kind: EventKind;
  title?: string;
  content: string;
  rawData?: Record<string, unknown>;
  mediaUrls?: string[];
  eventAt: number;
  confidence?: number;
  tags?: Record<string, unknown>;
  location?: { lat: number; lon: number };
  /**
   * Optional override for the deduplication seed. When set, the scheduler hashes
   * this instead of `content`. CV events use it to embed a coarse time bucket so
   * identical consecutive readings (e.g. a static "2 cars") are not collapsed
   * into a single event, preserving the per-poll time series.
   */
  dedupeContent?: string;
  /**
   * Transient REDACTED best-frame (base64 jpeg) attached to a CV alert. NOT
   * persisted in the event/tags — the scheduler hands it to the cv_alerts store
   * and drops it, so imagery never lands in intelligence_events.
   */
  artifactBase64?: string;
  /**
   * Transient CLIP embedding of the REDACTED alert frame (semantic search). NOT
   * stored in intelligence_events — the scheduler writes it to cv_embeddings.
   * INVARIANT: any adapter populating this MUST derive it from a sidecar response
   * with redaction_applied===true (i.e. an embedding of a redacted frame only).
   */
  embeddingVector?: number[];
}

// ---------------------------------------------------------------------------
// Computer-vision (CV sidecar) types. Aggregates ONLY — no identity, no tracks,
// no free text. The shape mirrors the sidecar's `/v1/analyze` allowlisted output
// after `sanitizeCvResult()` in src/processors/detection.ts.
// ---------------------------------------------------------------------------

export type CrowdDensity = 'empty' | 'light' | 'moderate' | 'busy' | 'crowded';
export type CvAnomalyReason = 'crowd' | 'count_spike' | 'loitering' | 'overspeed' | 'wrong_way';

export interface CvZoneResult {
  id: string;
  occupancy: number;
  peakOccupancy?: number;
  name?: string;
  classCounts?: Record<string, number>;
}

export interface CvLineResult {
  id: string;
  in: number;
  out: number;
  name?: string;
  perClass?: Record<string, { in: number; out: number }>;
}

/**
 * One consolidated object track from a clip. ANONYMOUS aggregates only:
 * `trackKey` is an opaque per-response hash (NOT the raw tracker_id, which never
 * leaves the sidecar), `label` is the COCO class, and there is no appearance,
 * embedding, or cross-camera identity.
 */
export interface CvTrack {
  trackKey: string;
  label: string;
  topScore: number;
  framesSeen: number;
  firstSeenMs: number;
  lastSeenMs: number;
  maxDwellSec?: number;
  zonesEntered: string[];
  edgeTouched: boolean;
  /** Estimated speed (km/h) — only when the source provides speed calibration. */
  speedKmh?: number;
  /** Direction of travel in degrees (0 = +x / right, 90 = down) — speed mode only. */
  headingDeg?: number;
  /** Coarse spatial bucket "BXxBY" (e.g. "4x5"). Node composes the cross-clip
   * dedupe key from this + sourceId + sorted zones + label — the sidecar has no
   * free-text channel into the DB. */
  bboxBucket?: string;
}

export interface CvAnalytics {
  /** Per-class integer counts, e.g. { person: 3, car: 1 }. Anonymous aggregates. */
  counts: Record<string, number>;
  /** Peak simultaneous person count in any single frame (crowd rules). */
  peakPerson?: number;
  crowdDensity: CrowdDensity;
  zones: CvZoneResult[];
  lines: CvLineResult[];
  /** Confirmed tracks (clip mode only; empty for single-frame analysis). */
  tracks: CvTrack[];
  dwellMaxSec?: number;
  anomaly: { detected: boolean; reasons: CvAnomalyReason[] };
  scene: { activityLevel: 'low' | 'medium' | 'high'; weather?: string; label?: string };
  model: string;
  framesAnalyzed: number;
  /** Clip metadata when analysed from a clip; absent for single-frame. */
  clip?: { fps: number; frames: number; durationSec: number };
}

/** Per-source CV geometry, stored in `intelligence_sources.config.cv`. */
export interface ZoneConfig {
  id: string;
  name?: string;
  /** Fractional polygon points [[x,y],...] in 0..1, resolution-independent. */
  polygon: [number, number][];
  objectClasses?: string[];
  dwellThresholdSec?: number;
}

export interface LineConfig {
  id: string;
  name?: string;
  start: [number, number];
  end: [number, number];
}

// ---- P2: alert rules (the "signal-not-noise" layer) ----
export type AlertType = 'zone_breach' | 'loitering' | 'crowd_threshold' | 'line_surge';

export interface AlertRule {
  id: string;
  type: AlertType;
  /** Target zone (zone_breach / loitering) or line (line_surge). */
  zoneId?: string;
  lineId?: string;
  /** Trigger when the measured value >= threshold (occupancy / dwellSec / count / crossings). */
  threshold: number;
  /** 'alert' = push-worthy (default); 'detection' = record-only. */
  severity?: 'alert' | 'detection';
}

export interface AlertFiring {
  ruleId: string;
  type: AlertType;
  zoneId?: string;
  lineId?: string;
  value: number;
  threshold: number;
  severity: 'alert' | 'detection';
}

/** Per-camera homography for speed/heading estimation (operator-calibrated). */
export interface SpeedCalibration {
  /** 4 image points (fractional 0..1) and their real-world metres, in the same order. */
  imagePoints: [number, number][];
  worldPoints: [number, number][];
  maxKmh?: number;
  /** Expected travel heading (deg); a track deviating > 90° is flagged wrong-way. */
  expectedHeadingDeg?: number;
}

export interface CvSourceConfig {
  region?: 'EU' | 'non_EU' | 'unknown';
  watchClasses?: string[];
  zones?: ZoneConfig[];
  lines?: LineConfig[];
  /** Pull a short clip for tracking/line-crossing instead of a single frame. */
  clipMode?: boolean;
  /** Per-source overrides for clip acquisition (else CV_CLIP_SECONDS/CV_SAMPLED_FPS). */
  clipSeconds?: number;
  sampledFps?: number;
  /** Alert rules evaluated against the clip's aggregates (P2). */
  rules?: AlertRule[];
  /** Speed/heading calibration (P2) — enables overspeed / wrong-way detection. */
  speed?: SpeedCalibration;
}

export interface IntelligenceEvent {
  id: string;
  sourceId: string;
  kind: EventKind;
  title?: string;
  content: string;
  rawData?: Record<string, unknown>;
  mediaUrls?: string[];
  embedding?: Buffer;
  vectorV?: number[];
  confidence: number;
  sensitivity: Sensitivity;
  tags: Record<string, unknown>;
  location?: { lat: number; lon: number };
  eventAt: number;
  createdAt: number;
  dedupeHash?: string;
  /** Composite importance score in 0..1 (005). Ordering key for "most important first". */
  score?: number;
  scoreComponents?: ScoreComponents;
}

/** Breakdown of the composite event score (scoring/score.ts). */
export interface ScoreComponents {
  severity: number;
  threat: number;
  corroboration: number;
  sourceTrust: number;
  freshness: number;
  base: number;
}

// ---------------------------------------------------------------------------
// 005: correlation/freshness signals, multi-channel delivery, grounded briefs.
// ---------------------------------------------------------------------------

export type SignalKind =
  | 'convergence'
  | 'geo_convergence'
  | 'velocity_spike'
  | 'silent_source'
  | 'volume_anomaly'
  | 'cluster_surge';

export interface IntelSignal {
  id: string;
  kind: SignalKind;
  score: number;
  title: string;
  summary?: string;
  clusterId?: string;
  sourceIds?: string[];
  eventIds?: string[];
  location?: { lat: number; lon: number };
  windowStart?: number;
  windowEnd?: number;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export type ChannelKind = 'telegram' | 'discord' | 'slack' | 'webhook' | 'email' | 'samaritan';

export interface DeliveryChannel {
  id: string;
  userId: string;
  kind: ChannelKind;
  config: Record<string, unknown>;
  enabled: boolean;
  quietHours?: { tz?: string; startHour: number; endHour: number };
  createdAt: number;
}

export interface Brief {
  id: string;
  userId?: string;
  lead: string;
  body: { threads?: unknown[]; signals?: unknown[]; rankedEventIds?: string[] };
  eventCount: number;
  windowStart?: number;
  windowEnd?: number;
  createdAt: number;
}

export interface Subscription {
  id: string;
  userId: string;
  sourceId: string;
  filterQuery?: string;
  minConfidence: number;
  allowedKinds?: EventKind[];
  deliveryMode: DeliveryMode;
  digestCron?: string;
  lastDeliveredAt?: number;
  createdAt: number;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  readonly name: string;
  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] };
  poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]>;
  subscribe?(
    config: Record<string, unknown>,
    handler: (event: RawEvent) => void,
  ): Promise<() => void>;
  health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }>;
}

export interface ProcessorResult {
  title?: string;
  content: string;
  confidence: number;
  tags: Record<string, unknown>;
  sensitivity: Sensitivity;
}
