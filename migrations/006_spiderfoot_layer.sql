-- 006: SpiderFoot-inspired layer (clean-room, MIT).
--
-- SpiderFoot (smicallef/spiderfoot, MIT, Copyright 2022 Steve Micallef) was an
-- IDEA source for this layer: a queryable event-lineage edge table (promoting the
-- already-stamped tags.parent_event_id), operator triage state on signals, a
-- discrete risk band, an optional data-class axis, and an Area-of-Interest table.
-- No SpiderFoot code or schema was copied; the column choices below are original.
--
-- IMPORTANT: migrations/run.ts re-applies every 0NNN_*.sql on each run, so every
-- statement here MUST be idempotent (IF [NOT] EXISTS / ADD COLUMN IF NOT EXISTS).

-- ---------------------------------------------------------------------------
-- Event lineage: promote the trapped `tags.parent_event_id` provenance written
-- by the ~16 recon processors into a queryable, indexed event->event edge.
-- No hard FK: recon events use synthetic ids and 30d retention can purge a
-- parent before its child; orphans are tolerated and swept with the corpus.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_lineage (
  child_event_id  TEXT NOT NULL,
  parent_event_id TEXT NOT NULL,
  relation        TEXT NOT NULL DEFAULT 'derived',
  processor       TEXT,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (child_event_id, parent_event_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_event_lineage_child  ON event_lineage (child_event_id);
CREATE INDEX IF NOT EXISTS idx_event_lineage_parent ON event_lineage (parent_event_id);

-- Speeds the lineage backfill + "find children" reads straight off the events
-- table (the provenance lives in tags->>'parent_event_id').
CREATE INDEX IF NOT EXISTS idx_intel_events_parent
  ON intelligence_events ((tags->>'parent_event_id'))
  WHERE tags->>'parent_event_id' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Signal triage + discrete band (operator workability for the firehose).
-- ---------------------------------------------------------------------------
ALTER TABLE intelligence_signals ADD COLUMN IF NOT EXISTS triage_state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE intelligence_signals ADD COLUMN IF NOT EXISTS muted_until  BIGINT;
ALTER TABLE intelligence_signals ADD COLUMN IF NOT EXISTS risk_band    TEXT;
CREATE INDEX IF NOT EXISTS idx_intel_signals_triage ON intelligence_signals (triage_state);

-- Persisted mutes keyed by a signal's dedupe key, so a recurring convergence/geo
-- signal an operator silenced stays silenced across re-fires (the detectors gate
-- on this before inserting a new row).
CREATE TABLE IF NOT EXISTS signal_mutes (
  dedupe_key  TEXT PRIMARY KEY,
  muted_until BIGINT,
  reason      TEXT,
  created_at  BIGINT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Event taxonomy: discrete risk band + optional finding-class axis.
-- ---------------------------------------------------------------------------
ALTER TABLE intelligence_events ADD COLUMN IF NOT EXISTS risk_band  TEXT;
ALTER TABLE intelligence_events ADD COLUMN IF NOT EXISTS data_class TEXT;
CREATE INDEX IF NOT EXISTS idx_intel_events_data_class
  ON intelligence_events (data_class) WHERE data_class IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Area of Interest: operator-defined geos / entities / domains where matching
-- events are scored up and out-of-AOI matches tagged 'affiliate' (scoring/aoi.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intelligence_aoi (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'geo_bbox' | 'geo_radius' | 'country' | 'region' | 'entity' | 'domain' | 'keyword'
  definition  JSONB NOT NULL,         -- shape depends on kind
  weight      REAL NOT NULL DEFAULT 1.0,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intel_aoi_enabled ON intelligence_aoi (enabled);
