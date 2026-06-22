-- 008: collapse CROSS-SOURCE duplicate events.
--
-- WHY: the same upstream record is often ingested by multiple overlapping feeds
-- (e.g. one NWS alert appears in both the "tornado" and "severe+" feeds). The dedupe
-- hash mixed in sourceId, so these were never caught — ~576 byte-identical rows under
-- different sources. The code fix (hash a stable upstream id WITHOUT sourceId)
-- prevents new ones; this removes the existing duplicates.
--
-- Run ONCE in the Supabase SQL editor (idempotent — safe to re-run).
-- Distinct alerts have distinct content, so keying on (kind, content) only removes
-- true duplicates; the earliest row in each group is kept.

BEGIN;
SET LOCAL search_path = samaritan, public, extensions;

CREATE TEMP TABLE _xsrc_dups ON COMMIT DROP AS
SELECT id FROM (
  SELECT id,
         row_number() OVER (PARTITION BY kind, md5(content) ORDER BY created_at, ctid) AS rn
  FROM intelligence_events
) t
WHERE rn > 1;

-- intelligence_deliveries is the only FK without ON DELETE CASCADE/SET NULL.
DELETE FROM intelligence_deliveries WHERE event_id IN (SELECT id FROM _xsrc_dups);
DELETE FROM intelligence_events     WHERE id       IN (SELECT id FROM _xsrc_dups);

COMMIT;
