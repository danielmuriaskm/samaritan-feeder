-- Intelligence Feeder schema
-- Run this in the same Postgres instance as Samaritan (shared connection)

CREATE TABLE IF NOT EXISTS intelligence_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'instagram', 'twitter', 'reddit', 'bluesky', 'tiktok',
    'webcam', 'traffic_cam', 'weather_cam', 'ip_camera',
    'rss', 'news_api', 'gdelt', 'github', 'hn', 'arxiv'
  )),
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  poll_interval_seconds INT NOT NULL DEFAULT 300,
  last_polled_at BIGINT,
  last_event_at BIGINT,
  error_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by_user_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS intelligence_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('visual', 'text', 'anomaly', 'trend', 'alert', 'social_post')),
  title TEXT,
  content TEXT NOT NULL,
  raw_data JSONB,
  media_urls TEXT[],
  embedding BYTEA,
  vector_v vector(768),
  confidence REAL NOT NULL DEFAULT 0.5,
  sensitivity TEXT NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public','normal','private')),
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  location_lat REAL,
  location_lon REAL,
  event_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  dedupe_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_intel_events_source ON intelligence_events(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_events_kind ON intelligence_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_events_vector_hnsw ON intelligence_events USING hnsw (vector_v vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_intel_events_dedupe ON intelligence_events(dedupe_hash) WHERE dedupe_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS intelligence_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  filter_query TEXT,
  min_confidence REAL DEFAULT 0.6,
  allowed_kinds TEXT[],
  delivery_mode TEXT NOT NULL DEFAULT 'passive' CHECK (delivery_mode IN ('passive', 'proactive', 'alert')),
  digest_cron TEXT,
  last_delivered_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, source_id)
);

CREATE TABLE IF NOT EXISTS intelligence_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES intelligence_events(id),
  user_id TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'web_push', 'sse', 'mcp')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'suppressed')),
  error TEXT,
  created_at BIGINT NOT NULL
);


CREATE TABLE IF NOT EXISTS samaritan.instagram_tokens (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  instagram_user_id TEXT,
  obtained_at BIGINT NOT NULL,
  expires_at BIGINT
);
