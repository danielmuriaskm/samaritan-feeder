// Shared types mirroring the feeder API (kept loose; the server is the source of truth).

export interface ScoreComponents {
  severity: number;
  threat: number;
  corroboration: number;
  sourceTrust: number;
  freshness: number;
  base: number;
}

// 006: discrete band + finding-class axis.
export type RiskBand = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';
export type TriageState = 'open' | 'acknowledged' | 'dismissed';
export type DataClass =
  | 'hazard_alert' | 'cyber_ioc' | 'vulnerability' | 'breach_leak' | 'leaked_secret'
  | 'exposed_service' | 'malware' | 'phishing' | 'defacement' | 'recon_finding'
  | 'cv_detection' | 'social_post' | 'news' | 'research' | 'other';

export interface IntelEvent {
  id: string;
  sourceId: string;
  kind: string;
  title?: string;
  content: string;
  confidence: number;
  score?: number;
  scoreComponents?: ScoreComponents & { aoi?: number };
  riskBand?: RiskBand;
  dataClass?: DataClass;
  eventAt: number;
  createdAt?: number;
  tags: Record<string, unknown>;
  location?: { lat: number; lon: number };
}

export type SourceHealthState = 'healthy' | 'degraded' | 'silent' | 'failing' | 'cooldown';

export interface Source {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  pollIntervalSeconds: number;
  lastPolledAt?: number;
  lastEventAt?: number;
  errorCount: number;
  consecutiveFailures?: number;
  cooldownUntil?: number;
  lastLatencyMs?: number;
  healthState?: SourceHealthState;
}

export type SignalKind =
  | 'convergence'
  | 'geo_convergence'
  | 'velocity_spike'
  | 'silent_source'
  | 'volume_anomaly'
  | 'cluster_surge'
  | 'outlier'
  | 'uncorroborated'
  | 'rule_match';

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
  metadata?: Record<string, unknown>;
  createdAt: number;
  // 006: operator triage + discrete band.
  triageState?: TriageState;
  mutedUntil?: number;
  riskBand?: RiskBand;
}

export interface SignalMute {
  dedupeKey: string;
  mutedUntil?: number;
  reason?: string;
}

// 006: Area of Interest (scope weighting).
export type AoiKind = 'geo_bbox' | 'geo_radius' | 'country' | 'region' | 'entity' | 'domain' | 'keyword';
export interface AoiRule {
  id: string;
  name: string;
  kind: AoiKind;
  definition: Record<string, unknown>;
  weight: number;
  enabled: boolean;
  createdAt: number;
}

// Per-source delivery subscription (pre-existing /subscriptions route).
export type DeliveryMode = 'passive' | 'proactive' | 'alert';
export interface Subscription {
  id: string;
  userId: string;
  sourceId: string;
  filterQuery?: string;
  minConfidence: number;
  allowedKinds?: string[];
  deliveryMode: DeliveryMode;
  digestCron?: string;
  lastDeliveredAt?: number;
  createdAt: number;
}

// CV (computer-vision sidecar) read shapes — kept loose; server is source of truth.
export interface CvAlertRow {
  id?: string;
  sourceId?: string;
  type?: string;
  value?: number;
  threshold?: number;
  severity?: string;
  createdAt?: number;
  eventAt?: number;
  [k: string]: unknown;
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

export type ChannelKind = 'telegram' | 'discord' | 'slack' | 'webhook' | 'email' | 'samaritan';

export interface Channel {
  id: string;
  userId: string;
  kind: ChannelKind;
  config: Record<string, unknown>;
  enabled: boolean;
  quietHours?: { tz?: string; startHour: number; endHour: number };
  createdAt: number;
}
