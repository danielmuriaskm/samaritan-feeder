-- P2: CV alert-rule firings. One row per fired rule, linked to the kind:'alert'
-- intelligence_event. best_frame is a REDACTED jpeg (only when CV_STORE_ARTIFACTS
-- is on) and is purged at RAW_DATA_RETENTION_DAYS by the cleanup job.
CREATE TABLE IF NOT EXISTS cv_alerts (
  id          TEXT PRIMARY KEY,
  event_id    TEXT REFERENCES intelligence_events(id) ON DELETE SET NULL,
  source_id   TEXT NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  rule_id     TEXT NOT NULL,
  alert_type  TEXT NOT NULL CHECK (alert_type IN ('zone_breach','loitering','crowd_threshold','line_surge')),
  zone_id     TEXT,
  line_id     TEXT,
  value       REAL NOT NULL,
  threshold   REAL NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'alert' CHECK (severity IN ('alert','detection')),
  best_frame  BYTEA,                          -- REDACTED; purged at 7d
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_alerts_source ON cv_alerts(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cv_alerts_type ON cv_alerts(alert_type, created_at DESC);
