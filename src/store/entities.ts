import { query, one, exec, transact } from '../db.js';
import { isLowValueEntity, type ExtractedEntity } from '../processors/entityExtract.js';

export interface Entity {
  id: string;
  type: string;
  value: string;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  metadata: Record<string, unknown>;
}

export interface EventEntityLink {
  eventId: string;
  entityId: string;
  confidence: number;
  context?: string;
}

/**
 * One-time recolor of the graph: the old guessEntityType default labeled EVERY
 * bare LLM string 'domain' (blue), so the graph was a wall of identical nodes.
 * Re-type the mislabeled ones — anything stored as 'domain' whose value is NOT a
 * real dotted hostname becomes 'org' (the new default). Real domains (with a
 * .TLD) are left alone. Idempotent; new ingest gets finer place/product/tech
 * types. Returns rows changed.
 */
export async function backfillEntityTypes(): Promise<number> {
  const rows = await query<{ count: string }>(
    `WITH u AS (
       UPDATE intelligence_entities SET type = 'org'
        WHERE type = 'domain' AND value !~* '\\.[a-z]{2,}$'
        RETURNING 1
     ) SELECT COUNT(*)::text AS count FROM u`,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function upsertEntity(entity: ExtractedEntity, now: number): Promise<string> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM intelligence_entities WHERE type = $1 AND value = $2`,
    [entity.type, entity.value],
  );

  if (existing) {
    await exec(
      `UPDATE intelligence_entities
       SET last_seen_at = $1, event_count = event_count + 1, metadata = metadata || $2::jsonb
       WHERE id = $3`,
      [now, JSON.stringify(entity.context ? { last_context: entity.context } : {}), existing.id],
    );
    return existing.id;
  }

  const id = generateEntityId();
  await exec(
    `INSERT INTO intelligence_entities (id, type, value, first_seen_at, last_seen_at, event_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      entity.type,
      entity.value,
      now,
      now,
      1,
      JSON.stringify(entity.context ? { first_context: entity.context } : {}),
    ],
  );
  return id;
}

export async function linkEventToEntity(eventId: string, entityId: string, confidence: number, context?: string): Promise<void> {
  await exec(
    `INSERT INTO event_entities (event_id, entity_id, confidence, context)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id, entity_id) DO NOTHING`,
    [eventId, entityId, confidence, context ?? null],
  );
}

export async function extractAndLinkEntities(event: { id: string; title?: string; content: string; tags: Record<string, unknown> }): Promise<void> {
  const { extractEntities } = await import('../processors/entityExtract.js');
  const text = `${event.title ?? ''} ${event.content}`;

  // Use existing entities from tags if present (from LLM processor)
  let entities: ExtractedEntity[] = [];
  const tagEntities = event.tags.entities;
  if (Array.isArray(tagEntities)) {
    for (const e of tagEntities) {
      if (typeof e === 'string') {
        // Heuristic type detection for string entities from LLM
        const type = guessEntityType(e);
        entities.push({ type, value: e.toLowerCase().trim(), confidence: 0.7 });
      } else if (e && typeof e === 'object') {
        const obj = e as Record<string, unknown>;
        if (typeof obj.value === 'string' && typeof obj.type === 'string') {
          entities.push({
            type: normalizeEntityType(obj.type, obj.value),
            value: obj.value.toLowerCase().trim(),
            confidence: Number(obj.confidence ?? 0.7),
          });
        }
      }
    }
  }

  // Also run regex extraction to catch anything the LLM missed
  const regexEntities = extractEntities(text);
  const seen = new Set(entities.map((e) => `${e.type}:${e.value}`));
  for (const e of regexEntities) {
    const key = `${e.type}:${e.value}`;
    if (!seen.has(key)) {
      entities.push(e);
      seen.add(key);
    }
  }

  // Drop generic/low-value entities ("ai", "data", stopwords, ultra-short) so the
  // intelligence graph isn't dominated by noisy hubs. Structured IOC types (ip,
  // domain, email, hash, cve, …) are never filtered.
  entities = entities.filter((e) => !isLowValueEntity(e.type, e.value));

  if (entities.length === 0) return;

  const now = Date.now();
  await transact(async () => {
    for (const entity of entities) {
      const entityId = await upsertEntity(entity, now);
      await linkEventToEntity(event.id, entityId, entity.confidence, entity.context);
    }
  });
}

export async function getEntityById(id: string): Promise<Entity | undefined> {
  const row = await one<Record<string, unknown>>(
    `SELECT * FROM intelligence_entities WHERE id = $1`,
    [id],
  );
  return row ? fromEntityRow(row) : undefined;
}

export async function searchEntities(opts: { type?: string; value?: string; limit?: number }): Promise<Entity[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.type) { conditions.push(`type = $${idx++}`); params.push(opts.type); }
  if (opts.value) { conditions.push(`value ILIKE $${idx++}`); params.push(`%${opts.value}%`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_entities ${where} ORDER BY event_count DESC, last_seen_at DESC LIMIT $${idx++}`,
    [...params, opts.limit ?? 50],
  );
  return rows.map(fromEntityRow);
}

export async function getEventEntities(eventId: string): Promise<(Entity & { linkConfidence: number; context?: string })[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT e.*, ee.confidence as link_confidence, ee.context
     FROM intelligence_entities e
     JOIN event_entities ee ON e.id = ee.entity_id
     WHERE ee.event_id = $1
     ORDER BY ee.confidence DESC`,
    [eventId],
  );
  return rows.map((r) => ({
    ...fromEntityRow(r),
    linkConfidence: Number(r.link_confidence),
    context: r.context ? String(r.context) : undefined,
  }));
}

export async function getEntityEvents(entityId: string): Promise<{ eventId: string; eventAt: number; title?: string; confidence: number }[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ie.id as event_id, ie.event_at, ie.title, ee.confidence
     FROM intelligence_events ie
     JOIN event_entities ee ON ie.id = ee.event_id
     WHERE ee.entity_id = $1
     ORDER BY ie.event_at DESC`,
    [entityId],
  );
  return rows.map((r) => ({
    eventId: String(r.event_id),
    eventAt: Number(r.event_at),
    title: r.title ? String(r.title) : undefined,
    confidence: Number(r.confidence),
  }));
}

export async function getRelatedEntities(entityId: string): Promise<(Entity & { sharedEvents: number })[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT e.*, COUNT(*)::int as shared_events
     FROM intelligence_entities e
     JOIN event_entities ee1 ON e.id = ee1.entity_id
     JOIN event_entities ee2 ON ee1.event_id = ee2.event_id
     WHERE ee2.entity_id = $1 AND e.id != $1
     GROUP BY e.id
     ORDER BY shared_events DESC`,
    [entityId],
  );
  return rows.map((r) => ({
    ...fromEntityRow(r),
    sharedEvents: Number(r.shared_events),
  }));
}

function fromEntityRow(row: Record<string, unknown>): Entity {
  return {
    id: String(row.id),
    type: String(row.type),
    value: String(row.value),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    eventCount: Number(row.event_count),
    metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown>) : {},
  };
}

function generateEntityId(): string {
  return `ent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function guessEntityType(value: string): ExtractedEntity['type'] {
  const raw = value.trim();
  const v = raw.toLowerCase();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return 'ipv4';
  if (/^cve-\d{4}-\d{4,}$/i.test(v)) return 'cve';
  // Ethereum 0x{40} before any generic hex check so it isn't lost.
  if (/^0x[a-f0-9]{40}$/i.test(v)) return 'eth_address';
  // Hashes: most-specific (longest) first so e.g. a 128-hex string isn't
  // mislabeled as a 64-hex SHA-256.
  if (/^[a-f0-9]{128}$/i.test(v)) return 'hash_sha512';
  if (/^[a-f0-9]{64}$/i.test(v)) return 'hash_sha256';
  if (/^[a-f0-9]{40}$/i.test(v)) return 'hash_sha1';
  if (/^[a-f0-9]{32}$/i.test(v)) return 'hash_md5';
  if (v.includes('@')) return 'email';
  if (/^as\d+$/.test(v)) return 'asn';
  // Generic URL.
  if (/^https?:\/\//i.test(v)) return 'url';
  // Web-analytics IDs (UA-/G-/GTM-/pub-) — matched case-insensitively.
  if (/^(?:ua-\d{4,10}-\d{1,4}|g-[a-z0-9]{6,12}|gtm-[a-z0-9]{5,9}|pub-\d{14,22})$/i.test(v)) return 'analytics_id';
  // IBAN: structural check + mod-97 checksum.
  if (/^[a-z]{2}\d{2}[a-z0-9]{11,30}$/i.test(v) && isValidIbanChecksum(raw)) return 'iban';
  // A dotted hostname with a TLD is a real domain. Otherwise a bare string from a
  // news post (e.g. "OpenAI", "France") is almost always an org/name — default to
  // 'org', NOT 'domain' (the old default painted every untyped entity the same
  // blue, which is why the graph was a wall of identical nodes).
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v) && !/\s/.test(v)) return 'domain';
  return 'org';
}

/**
 * Fold an LLM-supplied entity `type` onto our controlled vocabulary so graph node
 * colors are meaningful. Structured IOC types pass through; free-text labels are
 * synonym-mapped to org/person/place/product/tech; anything unrecognized falls
 * back to value-based guessEntityType (which now defaults to 'org').
 */
function normalizeEntityType(rawType: unknown, value: string): ExtractedEntity['type'] {
  const t = String(rawType ?? '').toLowerCase().trim();
  const structured = new Set([
    'ipv4', 'ipv6', 'domain', 'email', 'hash_md5', 'hash_sha1', 'hash_sha256', 'hash_sha512',
    'cve', 'asn', 'btc_address', 'eth_address', 'iban', 'credit_card', 'analytics_id', 'pgp_key', 'url',
  ]);
  if (structured.has(t)) return t as ExtractedEntity['type'];
  if (t === 'ip') return 'ipv4';
  if (t === 'hash') return 'hash_sha256';
  if (['org', 'organization', 'organisation', 'company', 'corporation', 'agency', 'government', 'institution', 'team', 'startup', 'brand'].includes(t)) return 'org';
  if (['person', 'people', 'individual', 'name', 'author', 'user'].includes(t)) return 'person';
  if (['place', 'location', 'country', 'city', 'region', 'gpe', 'geo', 'area'].includes(t)) return 'place';
  if (['product', 'app', 'application', 'service', 'model', 'tool', 'platform', 'device'].includes(t)) return 'product';
  if (['tech', 'technology', 'framework', 'language', 'protocol', 'library', 'standard', 'concept', 'topic', 'keyword'].includes(t)) return 'tech';
  return guessEntityType(value);
}

/**
 * IBAN mod-97 checksum (ISO 7064), digit-by-digit to avoid integer overflow.
 * Mirrors the validator in entityExtract.ts so guessEntityType can label
 * LLM-supplied IBAN strings without importing the extractor.
 */
function isValidIbanChecksum(value: string): boolean {
  const v = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const chunk =
      ch >= '0' && ch <= '9'
        ? ch
        : String(ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10);
    for (const d of chunk) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Same-operator pivot for web-analytics IDs (clean-room port of the idea behind
 * SpiderFoot's sfp_webanalytics correlation): given an analytics_id value (GA
 * UA-/G-, GTM-, AdSense pub-), find the domain/host entities that co-occur with
 * that same id in events. Two sites sharing one analytics id are commonly run
 * by the same operator.
 *
 * Best-effort and read-only. Modeled on getRelatedEntities(): we self-join
 * event_entities on shared events, anchored to the analytics_id entity, and
 * keep only the domain/url neighbours.
 */
export async function findSharedAnalyticsOperators(
  value: string,
): Promise<(Entity & { sharedEvents: number })[]> {
  const v = value.toLowerCase().trim();
  const rows = await query<Record<string, unknown>>(
    `SELECT e.*, COUNT(*)::int as shared_events
     FROM intelligence_entities anchor
     JOIN event_entities ee_anchor ON anchor.id = ee_anchor.entity_id
     JOIN event_entities ee_other ON ee_anchor.event_id = ee_other.event_id
     JOIN intelligence_entities e ON e.id = ee_other.entity_id
     WHERE anchor.type = 'analytics_id'
       AND anchor.value = $1
       AND e.id != anchor.id
       AND e.type IN ('domain', 'url')
     GROUP BY e.id
     ORDER BY shared_events DESC`,
    [v],
  );
  return rows.map((r) => ({
    ...fromEntityRow(r),
    sharedEvents: Number(r.shared_events),
  }));
}
