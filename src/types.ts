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
  | 'arxiv';

export type EventKind = 'visual' | 'text' | 'anomaly' | 'trend' | 'alert' | 'social_post';

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
}

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
