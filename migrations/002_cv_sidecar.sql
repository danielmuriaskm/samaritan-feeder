-- P1: CV sidecar — tracking, zones/lines, consolidated track events.
-- Applied by migrations/run.ts (which now globs 0*.sql in order).
-- All statements idempotent.

-- 1) Extend the EventKind CHECK with 'detection' (mirrors types.ts EventKind).
--    'detection' is the canonical per-clip CV analytics event.
ALTER TABLE intelligence_events DROP CONSTRAINT IF EXISTS intelligence_events_kind_check;
ALTER TABLE intelligence_events ADD CONSTRAINT intelligence_events_kind_check
  CHECK (kind IN ('visual','text','anomaly','trend','alert','social_post','detection'));

-- Per-source CV geometry (zones / lines / watch-classes) lives in
-- intelligence_sources.config.cv (JSONB) — read by the adapter and validated by
-- routes/sources.ts. No dedicated column is added (it would be dead schema).

-- 2) Consolidated track records: ONE row per confirmed object track, reconciled
--    across consecutive clips by dedupe_key so a parked car does not re-fire
--    every poll. Anonymous aggregates ONLY — there is no tracker_id / embedding /
--    identity column; identity is un-representable by design. best_frame is for
--    a future (P2) REDACTED artifact and is purged at RAW_DATA_RETENTION_DAYS.
CREATE TABLE IF NOT EXISTS cv_track_events (
  id            TEXT PRIMARY KEY,
  event_id      TEXT REFERENCES intelligence_events(id) ON DELETE CASCADE,
  source_id     TEXT NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,                 -- class only ('person','car'), never identity
  top_score     REAL NOT NULL,
  frames_seen   INT  NOT NULL,
  first_seen_ms BIGINT NOT NULL,
  last_seen_ms  BIGINT NOT NULL,
  max_dwell_sec REAL,
  zones_entered TEXT[],                        -- zone ids only
  edge_touched  BOOLEAN DEFAULT FALSE,
  dedupe_key    TEXT,                          -- source + zoneset + class + coarse bbox bucket
  best_frame    BYTEA,                         -- REDACTED jpeg (P2); NULL in P1
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_track_source ON cv_track_events(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cv_track_dedupe ON cv_track_events(dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL;

-- 4) Per-clip zone occupancy and line crossing counts (pure integers).
CREATE TABLE IF NOT EXISTS cv_zone_counts (
  id              TEXT PRIMARY KEY,
  event_id        TEXT REFERENCES intelligence_events(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  zone_id         TEXT,                        -- null for line rows
  line_id         TEXT,                        -- null for zone rows
  name            TEXT,
  peak_occupancy  INT,
  in_count        INT,
  out_count       INT,
  class_counts    JSONB NOT NULL DEFAULT '{}'::jsonb,
  window_start_ms BIGINT NOT NULL,
  window_end_ms   BIGINT NOT NULL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_zone_source ON cv_zone_counts(source_id, created_at DESC);
