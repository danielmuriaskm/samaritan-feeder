-- 005: Intelligence layer — scoring, correlation signals, source health + circuit
-- breaker, multi-channel delivery, grounded briefs, and new structured sources.
--
-- CLEAN-ROOM. The concepts here (composite scoring, cross-stream convergence,
-- freshness/silent-source detection, source tiering, multi-channel delivery) are
-- inspired by worldmonitor (AGPL-3.0) but NO worldmonitor code, schema, prompt,
-- or curated data table was copied. Methods are not copyrightable; the feeder
-- keeps its MIT license. See docs for the licensing boundary.
--
-- Applied by migrations/run.ts (globs 0*.sql in order). All statements idempotent.

-- 1) Composite score on events. The keystone: read paths can finally order by
--    "most important right now", not just "newest first" (ORDER BY event_at DESC).
ALTER TABLE intelligence_events ADD COLUMN IF NOT EXISTS score REAL;
ALTER TABLE intelligence_events ADD COLUMN IF NOT EXISTS score_components JSONB;
CREATE INDEX IF NOT EXISTS idx_intel_events_score
  ON intelligence_events(score DESC NULLS LAST, event_at DESC);

-- 2) Correlation / freshness signals. Cross-stream convergence, velocity spikes,
--    silent sources, cluster surges — the outputs the feeder never produced.
CREATE TABLE IF NOT EXISTS intelligence_signals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,        -- convergence | geo_convergence | velocity_spike | silent_source | volume_anomaly | cluster_surge
  score        REAL NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  summary      TEXT,
  cluster_id   TEXT,
  source_ids   TEXT[],
  event_ids    TEXT[],
  location_lat REAL,
  location_lon REAL,
  window_start BIGINT,
  window_end   BIGINT,
  dedupe_key   TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intel_signals_kind ON intelligence_signals(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_signals_score ON intelligence_signals(score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_signals_dedupe ON intelligence_signals(dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL;

-- 3) Per-source health + circuit-breaker state. Stop re-polling dead / rate-limited
--    sources every minute forever, and make "silent" (200 OK, zero events) visible.
ALTER TABLE intelligence_sources ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;
ALTER TABLE intelligence_sources ADD COLUMN IF NOT EXISTS cooldown_until BIGINT;
ALTER TABLE intelligence_sources ADD COLUMN IF NOT EXISTS last_latency_ms INT;
ALTER TABLE intelligence_sources ADD COLUMN IF NOT EXISTS health_state TEXT;  -- healthy | degraded | silent | failing | cooldown

-- 4) Source volume baselines (Welford online mean/variance) for volume-drop / burst
--    anomaly detection without storing a full history.
CREATE TABLE IF NOT EXISTS source_volume_baseline (
  source_id     TEXT PRIMARY KEY REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  mean_per_hour REAL NOT NULL DEFAULT 0,
  m2            REAL NOT NULL DEFAULT 0,
  sample_count  INT  NOT NULL DEFAULT 0,
  updated_at    BIGINT NOT NULL
);

-- 5) Multi-channel delivery — replace the single hardcoded telegram push.
CREATE TABLE IF NOT EXISTS delivery_channels (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('telegram','discord','slack','webhook','email','samaritan')),
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_hours JSONB,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_channels_user ON delivery_channels(user_id) WHERE enabled;

ALTER TABLE intelligence_deliveries DROP CONSTRAINT IF EXISTS intelligence_deliveries_channel_check;
ALTER TABLE intelligence_deliveries ADD CONSTRAINT intelligence_deliveries_channel_check
  CHECK (channel IN ('telegram','web_push','sse','mcp','discord','slack','webhook','email','samaritan'));

-- 6) Grounded briefs (synthesized digest output; fills the empty runDigestCycle).
CREATE TABLE IF NOT EXISTS intelligence_briefs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  lead         TEXT NOT NULL,
  body         JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_count  INT NOT NULL DEFAULT 0,
  window_start BIGINT,
  window_end   BIGINT,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intel_briefs_user ON intelligence_briefs(user_id, created_at DESC);

-- 7) New structured-source kinds (usgs/eonet/gdacs/nws/abusech/ngamsi/reliefweb).
--    DELIBERATELY NOT managed here. The repo's kind list has drifted below the
--    live deployment's kinds (mastodon, metoffice, nasa_firms, ...), so a
--    DROP+RECREATE of intelligence_sources_kind_check with a hardcoded list would
--    CONTRACT the live constraint and reject existing rows. Widen the live CHECK
--    additively (or drop it for app-side validation) via migrations/optional/
--    006_source_kinds.sql — kinds are independently validated in-app by the
--    adapter registry (routes/sources.ts rejects a kind with no adapter).
