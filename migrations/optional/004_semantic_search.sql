-- OPTIONAL (P2 semantic search). NOT applied by the default `db:migrate` glob —
-- run explicitly with `npm run db:migrate:semantic`.
--
-- REQUIRES a Postgres with the pgvector extension (e.g. the pgvector/pgvector:pg16
-- image). On a plain postgres image CREATE EXTENSION fails — which is exactly why
-- this lives outside the default migration set so it can't break other deploys.
--
-- Stores CLIP embeddings of REDACTED alert frames only (de-identified scene
-- vectors, not identities). The redacted JPEG is purged at 7d; these vectors are
-- the durable searchable archive and cascade-delete with their parent event.

CREATE EXTENSION IF NOT EXISTS vector;

-- IMPORTANT: vector(512) is for the DEFAULT CLIP model (ViT-B/32 = 512 dims).
-- If you change CV_CLIP_MODEL (e.g. ViT-L/14 = 768) you MUST edit BOTH the 512
-- below AND CV_CLIP_DIM (Node) AND the sidecar's CV_CLIP_DIM to the new size, and
-- rebuild the HNSW index. A mismatch fails the INSERT (caught + logged, never
-- breaks alerting) but yields no searchable rows.
CREATE TABLE IF NOT EXISTS cv_embeddings (
  id         TEXT PRIMARY KEY,
  event_id   TEXT REFERENCES intelligence_events(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
  embedding  vector(512),          -- MUST equal CV_CLIP_DIM
  caption    TEXT,                  -- PII-free alert summary for result display
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cv_embeddings_hnsw
  ON cv_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_cv_embeddings_source ON cv_embeddings(source_id, created_at DESC);
