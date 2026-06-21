import { Hono } from 'hono';
import { getEvent } from '../store/events.js';
import { getEntityById, getEventEntities, getEntityEvents, getRelatedEntities, searchEntities } from '../store/entities.js';

const app = new Hono();

// GET /api/graph/event/:id
app.get('/event/:id', async (c) => {
  const eventId = c.req.param('id');
  const event = await getEvent(eventId);
  if (!event) return c.json({ error: 'Event not found' }, 404);

  const entities = await getEventEntities(eventId);

  // Fetch co-occurring events for each entity
  const relatedEventsMap = new Map<string, typeof event>();
  for (const entity of entities) {
    const entityEvents = await getEntityEvents(entity.id);
    for (const ee of entityEvents) {
      if (ee.eventId !== eventId && !relatedEventsMap.has(ee.eventId)) {
        const ev = await getEvent(ee.eventId);
        if (ev) relatedEventsMap.set(ee.eventId, ev);
      }
    }
  }

  return c.json({
    event,
    entities,
    relatedEvents: Array.from(relatedEventsMap.values()),
  });
});

// GET /api/graph/entity/:id
app.get('/entity/:id', async (c) => {
  const entityId = c.req.param('id');
  const entity = await getEntityById(entityId);
  if (!entity) return c.json({ error: 'Entity not found' }, 404);

  const events = await getEntityEvents(entityId);
  const relatedEntities = await getRelatedEntities(entityId);

  return c.json({
    entity,
    events,
    relatedEntities,
  });
});

// GET /api/graph/search
app.get('/search', async (c) => {
  const type = c.req.query('type');
  const value = c.req.query('value');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  if (!type && !value) {
    return c.json({ error: 'Provide type or value query param' }, 400);
  }

  const entities = await searchEntities({ type, value, limit });
  return c.json({ entities });
});

// GET /api/graph/network
// Returns full network for a set of entity IDs (for graph visualization)
// If no seed provided, returns top entities + their connected events as default view
app.get('/network', async (c) => {
  const entityIdsParam = c.req.query('entityIds');
  const eventId = c.req.query('eventId');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);

  const nodes: Array<{ id: string; type: 'event' | 'entity'; label: string; kind?: string; entityType?: string }> = [];
  const links: Array<{ source: string; target: string; confidence: number }> = [];
  const seenNodes = new Set<string>();
  const seenLinks = new Set<string>();

  let seedEntityIds: string[] = [];

  if (eventId) {
    const event = await getEvent(eventId);
    if (!event) return c.json({ error: 'Event not found' }, 404);

    nodes.push({ id: event.id, type: 'event', label: event.title ?? event.kind, kind: event.kind });
    seenNodes.add(event.id);

    const entities = await getEventEntities(eventId);
    for (const e of entities) {
      if (!seenNodes.has(e.id)) {
        nodes.push({ id: e.id, type: 'entity', label: e.value, entityType: e.type });
        seenNodes.add(e.id);
      }
      const linkKey = `${event.id}-${e.id}`;
      if (!seenLinks.has(linkKey)) {
        links.push({ source: event.id, target: e.id, confidence: e.linkConfidence });
        seenLinks.add(linkKey);
      }
      seedEntityIds.push(e.id);
    }
  }

  if (entityIdsParam) {
    seedEntityIds.push(...entityIdsParam.split(','));
  }

  // Default view: top entities by event count if no seed provided
  if (seedEntityIds.length === 0) {
    const topEntities = await searchEntities({ limit });
    seedEntityIds = topEntities.map((e) => e.id);
  }

  // Expand 1 hop from seed entities
  for (const entityId of seedEntityIds) {
    const entity = await getEntityById(entityId);
    if (!entity) continue;

    if (!seenNodes.has(entity.id)) {
      nodes.push({ id: entity.id, type: 'entity', label: entity.value, entityType: entity.type });
      seenNodes.add(entity.id);
    }

    const events = await getEntityEvents(entityId);
    for (const ev of events.slice(0, 20)) { // cap events per entity to avoid explosion
      if (!seenNodes.has(ev.eventId)) {
        nodes.push({ id: ev.eventId, type: 'event', label: ev.title ?? 'Event', kind: undefined });
        seenNodes.add(ev.eventId);
      }
      const linkKey = `${ev.eventId}-${entity.id}`;
      if (!seenLinks.has(linkKey)) {
        links.push({ source: ev.eventId, target: entity.id, confidence: ev.confidence });
        seenLinks.add(linkKey);
      }
    }
  }

  return c.json({ nodes, links });
});

export default app;
