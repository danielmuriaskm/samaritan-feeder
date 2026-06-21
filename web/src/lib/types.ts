// Shared types mirroring the feeder API (kept loose; the server is the source of truth).

export interface ScoreComponents {
  severity: number;
  threat: number;
  corroboration: number;
  sourceTrust: number;
  freshness: number;
  base: number;
}

export interface IntelEvent {
  id: string;
  sourceId: string;
  kind: string;
  title?: string;
  content: string;
  confidence: number;
  score?: number;
  scoreComponents?: ScoreComponents;
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
  metadata?: Record<string, unknown>;
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
