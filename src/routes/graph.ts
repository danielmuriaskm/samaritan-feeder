import { Hono } from 'hono';
import { getEvent, getEventLineage } from '../store/events.js';
import { getEntityById, getEventEntities, getEntityEvents, getRelatedEntities, searchEntities } from '../store/entities.js';
import { toGexf, toSigmaJson, parentChildToTree, type GraphNode, type GraphEdge } from '../lib/exporters.js';

const app = new Hono();

// Node shape assembled by the /network route (see below).
type NetworkNode = { id: string; type: 'event' | 'entity'; label: string; kind?: string; entityType?: string };
type NetworkLink = { source: string; target: string; confidence: number };

/**
 * Low-signal "descriptor" entity types — attribute-like artifacts (file hashes,
 * CVE ids, ASNs, web-analytics ids) that attach to many events and dominate a
 * force-directed layout without adding investigative structure. `?tier=entity`
 * collapses them out so the graph shows the higher-signal entity backbone.
 *
 * Defined LOCALLY (not imported from entityExtract) on purpose: this is a
 * presentation/layout choice for the graph view, decoupled from the canonical
 * EntityType enum.
 */
const DESCRIPTOR_TYPES = new Set([
  'cve',
  'hash_md5',
  'hash_sha1',
  'hash_sha256',
  'hash_sha512',
  'asn',
  'analytics_id',
]);

/**
 * Map the route's internal {nodes, links} into the exporters' GraphNode/GraphEdge
 * shape. Clean-room reimplementation of the idea behind SpiderFoot's graph export
 * (smicallef/spiderfoot, MIT — helpers.py buildGraphJson / sfwebui.py GEXF viz):
 * node id + display label + a flat string/number attribute bag; edges carry a
 * weight. No SpiderFoot code is used — only the data-shape concept.
 */
function toGraphExportShape(
  nodes: NetworkNode[],
  links: NetworkLink[],
): { graphNodes: GraphNode[]; graphEdges: GraphEdge[] } {
  // eventCount per node = number of incident links (entities) / link fan-in.
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const graphNodes: GraphNode[] = nodes.map((n) => ({
    id: n.id,
    label: n.label,
    attributes: {
      type: n.type === 'entity' ? n.entityType ?? 'entity' : n.kind ?? 'event',
      tier: n.type,
      eventCount: degree.get(n.id) ?? 0,
    },
  }));
  const graphEdges: GraphEdge[] = links.map((l) => ({
    source: l.source,
    target: l.target,
    weight: l.confidence,
  }));
  return { graphNodes, graphEdges };
}

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
  const format = c.req.query('format'); // gexf | sigma | tree (default: legacy JSON)
  const tier = c.req.query('tier'); // 'entity' collapses DESCRIPTOR_TYPES nodes
  const includeLineage = c.req.query('includeLineage') === 'true';
  const root = c.req.query('root'); // required for format=tree

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

  // Optionally fold event→event provenance into the graph as additional edges.
  // Only edges between events ALREADY in the node set are added, so this composes
  // cleanly with the existing assembly (no new nodes, no extra DB fan-out beyond
  // the events we already surfaced).
  if (includeLineage) {
    const eventNodeIds = nodes.filter((n) => n.type === 'event').map((n) => n.id);
    for (const evId of eventNodeIds) {
      const { parents } = await getEventLineage(evId);
      for (const p of parents) {
        if (!seenNodes.has(p.eventId)) continue; // keep it in-graph
        const linkKey = `lineage:${p.eventId}-${evId}`;
        if (!seenLinks.has(linkKey)) {
          // Directed parent → child provenance edge. confidence 1 (recorded fact).
          links.push({ source: p.eventId, target: evId, confidence: 1 });
          seenLinks.add(linkKey);
        }
      }
    }
  }

  // tier=entity: drop low-signal descriptor nodes and any edge touching them.
  let outNodes = nodes;
  let outLinks = links;
  if (tier === 'entity') {
    const dropped = new Set(
      nodes.filter((n) => n.type === 'entity' && n.entityType && DESCRIPTOR_TYPES.has(n.entityType)).map((n) => n.id),
    );
    if (dropped.size) {
      outNodes = nodes.filter((n) => !dropped.has(n.id));
      outLinks = links.filter((l) => !dropped.has(l.source) && !dropped.has(l.target));
    }
  }

  // Alternate export formats. Default (no format) returns the legacy JSON unchanged.
  if (format) {
    const { graphNodes, graphEdges } = toGraphExportShape(outNodes, outLinks);

    if (format === 'gexf') {
      c.header('Content-Type', 'application/xml');
      c.header('Content-Disposition', 'attachment; filename="graph.gexf"');
      return c.body(toGexf(graphNodes, graphEdges));
    }
    if (format === 'sigma') {
      c.header('Content-Type', 'application/json');
      return c.body(toSigmaJson(graphNodes, graphEdges));
    }
    if (format === 'tree') {
      if (!root) return c.json({ error: 'format=tree requires a root query param (entity or event id)' }, 400);
      const maxDepth = Math.min(Math.max(1, Number(c.req.query('maxDepth') ?? 4)), 10);
      const labelOf = new Map(graphNodes.map((n) => [n.id, n.label ?? n.id] as const));
      const tree = parentChildToTree(root, graphEdges, { maxDepth, label: (id) => labelOf.get(id) });
      return c.json(tree);
    }
    return c.json({ error: `Unknown format '${format}' (expected gexf | sigma | tree)` }, 400);
  }

  return c.json({ nodes: outNodes, links: outLinks });
});

// GET /api/graph/lineage/:eventId
// Event provenance (006): parents and children of one event from event_lineage.
app.get('/lineage/:eventId', async (c) => {
  const eventId = c.req.param('eventId');
  const lineage = await getEventLineage(eventId);
  return c.json(lineage);
});

export default app;
