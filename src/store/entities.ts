import { query, one, exec, transact } from '../db.js';
import type { ExtractedEntity } from '../processors/entityExtract.js';

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
            type: obj.type as ExtractedEntity['type'],
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
  const v = value.toLowerCase().trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return 'ipv4';
  if (/^cve-\d{4}-\d{4,}$/i.test(v)) return 'cve';
  if (/^[a-f0-9]{32}$/i.test(v)) return 'hash_md5';
  if (/^[a-f0-9]{40}$/i.test(v)) return 'hash_sha1';
  if (/^[a-f0-9]{64}$/i.test(v)) return 'hash_sha256';
  if (v.includes('@')) return 'email';
  if (/^as\d+$/.test(v)) return 'asn';
  return 'domain';
}
