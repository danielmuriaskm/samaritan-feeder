-- 007: collapse duplicate events that share a dedupe_hash + enforce uniqueness.
--
-- WHY: dedupeExists() (a DB read) and createEvent() (the insert) are separated by a
-- long async enrichment pipeline, so within one poll the same item could pass the
-- existence check 2-3x concurrently and all insert. The code fix (in-process
-- reservation) prevents NEW dups; this migration removes the EXISTING ones and adds
-- a DB-level unique index so the invariant can never silently regress.
--
-- Run it ONCE in the Supabase SQL editor (it is idempotent — safe to re-run).
-- The app tolerates the unique index gracefully (createEvent's SQLSTATE-23505 catch).

BEGIN;
SET LOCAL search_path = samaritan, public, extensions;

-- Duplicates to drop: every row that is NOT the physically-earliest (lowest ctid)
-- in its dedupe_hash group. Keeps exactly one representative per hash.
CREATE TEMP TABLE _dup_events ON COMMIT DROP AS
SELECT DISTINCT a.id
FROM intelligence_events a
JOIN intelligence_events b
  ON a.dedupe_hash = b.dedupe_hash
 AND a.dedupe_hash IS NOT NULL
 AND a.ctid > b.ctid;

-- intelligence_deliveries is the only dependent FK without ON DELETE CASCADE/SET NULL,
-- so clear its rows for the doomed events first (their kept twin remains). The other
-- referencing tables (event_entities, cv_track_events, cv_zone_counts, cv embeddings,
-- cv_alerts) cascade or set-null on their own.
DELETE FROM intelligence_deliveries WHERE event_id IN (SELECT id FROM _dup_events);
DELETE FROM intelligence_events     WHERE id       IN (SELECT id FROM _dup_events);

-- Enforce dedup at the DB level (partial: NULL hashes are exempt and stay distinct).
CREATE UNIQUE INDEX IF NOT EXISTS intelligence_events_dedupe_hash_uniq
  ON intelligence_events (dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

COMMIT;
