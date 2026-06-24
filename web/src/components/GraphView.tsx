import React, { useEffect, useState, useCallback, useMemo, Suspense, lazy, useRef } from 'react';
import { colors, kindColors, entityColors, rgb } from '../lib/theme.js';
import {
  getGraphNetwork, getLineage, getGraphEntity, getGraphEvent, graphExportUrl,
  type GraphOpts, type LineageNeighbor,
  type GraphEntity, type GraphEntityEvent, type GraphRelatedEntity, type GraphEventEntity,
} from '../lib/api.js';
import type { IntelEvent } from '../lib/types.js';

const ForceGraph2D = lazy(() => import('react-force-graph-2d'));

interface GraphNode {
  id: string;
  type: 'event' | 'entity';
  label: string;
  kind?: string;
  entityType?: string;
}

interface GraphLink {
  source: string;
  target: string;
  confidence: number;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface Lineage {
  parents: LineageNeighbor[];
  children: LineageNeighbor[];
}

// Detail payloads for the selected-node drill-down (006). Entity = its events +
// co-occurring entities; Event = its extracted entities (+ events we don't render
// here since the existing Lineage panel covers event→event provenance).
interface EntityDetail {
  entity: GraphEntity;
  events: GraphEntityEvent[];
  relatedEntities: GraphRelatedEntity[];
}
interface EventDetail {
  event: IntelEvent;
  entities: GraphEventEntity[];
  relatedEvents: IntelEvent[];
}

// Canonical bucket names — the SINGLE source of truth shared by node coloring and
// the legend so a node's disc and its legend swatch can never diverge.
type EntityBucket =
  | 'org' | 'person' | 'place' | 'product' | 'tech'
  | 'ip' | 'domain' | 'email' | 'hash' | 'cve' | 'url' | 'default';

// Normalize the API's granular entityType keys (ipv4, hash_md5, btc_address, …)
// down to the canonical buckets in theme.ts `entityColors`. Pure presentation —
// no data/state is mutated. Used by BOTH entityColor() and the legend tally.
function entityBucket(entityType: string | undefined): EntityBucket {
  const t = (entityType ?? '').toLowerCase();
  if (t.startsWith('ip')) return 'ip';
  if (t.startsWith('hash')) return 'hash';
  if (t === 'domain') return 'domain';
  if (t === 'email') return 'email';
  if (t === 'cve') return 'cve';
  if (t === 'url') return 'url';
  if (t === 'org' || t === 'asn') return 'org';
  if (t === 'person') return 'person';
  if (t === 'place') return 'place';
  if (t === 'product') return 'product';
  if (t === 'tech') return 'tech';
  // Backend typing now produces these buckets directly; fall back if a raw key
  // happens to match a theme entry, else `default`.
  if (entityColors[t]) return t as EntityBucket;
  return 'default';
}

function entityColor(entityType: string | undefined): string {
  return entityColors[entityBucket(entityType)] ?? entityColors.default;
}

// Event nodes are drawn as hollow rings; a deliberate desaturated slate reads far
// better than the low-contrast colors.dim (#888) over the near-black canvas.
const EVENT_RING_COLOR = '#5a6b7a';

// Escape free LLM/user text before injecting into the nodeLabel HTML tooltip.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Compact "x ago" / "in x" relative time for detail rows. Defensive about
// epoch units: treat values < 1e12 as seconds.
function relTime(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${diff < 0 ? 'in ' : ''}${mins}m${diff < 0 ? '' : ' ago'}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${diff < 0 ? 'in ' : ''}${hrs}h${diff < 0 ? '' : ' ago'}`;
  const days = Math.round(hrs / 24);
  return `${diff < 0 ? 'in ' : ''}${days}d${diff < 0 ? '' : ' ago'}`;
}

function fmtDate(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString();
}

function GraphFallback() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.dim }}>
      Loading graph engine...
    </div>
  );
}

function GraphError({ message }: { message: string }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: colors.critical, gap: 8, padding: 20 }}>
      <div style={{ fontSize: 32 }}>⚠️</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Graph failed to load</div>
      <div style={{ fontSize: 12, color: colors.dim, textAlign: 'center' }}>{message}</div>
    </div>
  );
}

// Absolutely-positioned zoom-control cluster over the canvas (Fit / + / −).
const zoomClusterStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 5,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const zoomBtnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  border: `1px solid ${colors.border}`,
  background: colors.panel,
  color: colors.text,
  fontSize: 16,
  lineHeight: 1,
  cursor: 'pointer',
};
// Focus-mode banner (top-left over the canvas) doubling as a "clear focus" button.
const focusHintStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 5,
  padding: '5px 10px',
  borderRadius: 4,
  border: `1px solid ${colors.border}`,
  background: colors.panel,
  color: colors.text,
  fontSize: 12,
  cursor: 'pointer',
  maxWidth: 320,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

// Shared button-style for the export anchors + toggle pills, matching the dark wm-* look.
const exportLinkStyle = (disabled: boolean): React.CSSProperties => ({
  display: 'block',
  textAlign: 'center',
  padding: '6px 10px',
  borderRadius: 4,
  border: `1px solid ${colors.border}`,
  background: colors.base,
  color: disabled ? colors.muted : colors.text,
  fontSize: 12,
  textDecoration: 'none',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  pointerEvents: disabled ? 'none' : 'auto',
});

export default function GraphView() {
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('all');
  // 006 graph toggles.
  const [entityOnly, setEntityOnly] = useState(false);
  const [includeLineage, setIncludeLineage] = useState(false);
  // Declutter toggles — applied client-side to the rendered set (not the fetch).
  // hideIsolated drops degree-0 nodes (loose floating dots); ON by default.
  // hideWeak ALSO drops degree-1 leaf EVENT nodes (single-entity "flowers").
  const [hideIsolated, setHideIsolated] = useState(true);
  const [hideWeak, setHideWeak] = useState(false);
  // 006 lineage drill-down for the selected EVENT node.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  // 006 node drill-down — entity stats/events/related, and event extracted entities.
  const [entityDetail, setEntityDetail] = useState<EntityDetail | null>(null);
  const [entityDetailLoading, setEntityDetailLoading] = useState(false);
  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null);
  const [eventDetailLoading, setEventDetailLoading] = useState(false);
  const fgRef = useRef<any>(null);

  // Current export/fetch options derived from the toggles.
  const graphOpts: GraphOpts = {
    limit: 100,
    tier: entityOnly ? 'entity' : undefined,
    includeLineage,
  };

  const loadNetwork = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const json = (await getGraphNetwork({
        limit: 100,
        tier: entityOnly ? 'entity' : undefined,
        includeLineage,
      })) as unknown as GraphData;
      setData(json);
    } catch (err) {
      console.error('Failed to load graph:', err);
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [entityOnly, includeLineage]);

  // Re-fetch whenever the toggles change (and on mount).
  useEffect(() => {
    loadNetwork();
  }, [loadNetwork]);

  // Drill into event->event provenance for the selected node. Non-fatal: any
  // failure (non-event node, no lineage, network error) just shows "no lineage".
  useEffect(() => {
    let cancelled = false;
    if (!selectedNode || selectedNode.type !== 'event') {
      setLineage(null);
      setLineageLoading(false);
      return;
    }
    setLineage(null);
    setLineageLoading(true);
    (async () => {
      try {
        const res = await getLineage(selectedNode.id);
        if (!cancelled) setLineage(res);
      } catch (err) {
        console.error('Failed to load lineage:', err);
        if (!cancelled) setLineage({ parents: [], children: [] });
      } finally {
        if (!cancelled) setLineageLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  // Entity drill-down — stats + connected events + co-occurring entities. Mirrors
  // the lineage effect's cancelled/try-catch pattern; guarded on entity nodes.
  useEffect(() => {
    let cancelled = false;
    if (!selectedNode || selectedNode.type !== 'entity') {
      setEntityDetail(null);
      setEntityDetailLoading(false);
      return;
    }
    setEntityDetail(null);
    setEntityDetailLoading(true);
    (async () => {
      try {
        const res = await getGraphEntity(selectedNode.id);
        if (!cancelled) setEntityDetail(res);
      } catch (err) {
        console.error('Failed to load entity detail:', err);
        if (!cancelled) setEntityDetail(null);
      } finally {
        if (!cancelled) setEntityDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  // Event drill-down — the extracted entities behind an event node (rendered ABOVE
  // the existing event→event Lineage panel). Same cancelled/try-catch pattern.
  useEffect(() => {
    let cancelled = false;
    if (!selectedNode || selectedNode.type !== 'event') {
      setEventDetail(null);
      setEventDetailLoading(false);
      return;
    }
    setEventDetail(null);
    setEventDetailLoading(true);
    (async () => {
      try {
        const res = await getGraphEvent(selectedNode.id);
        if (!cancelled) setEventDetail(res);
      } catch (err) {
        console.error('Failed to load event detail:', err);
        if (!cancelled) setEventDetail(null);
      } finally {
        if (!cancelled) setEventDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  // react-force-graph-2d MUTATES the links array in place, replacing each link's
  // `source`/`target` string id with the resolved node OBJECT after the first
  // render. A naive `nodeIds.has(l.source)` then fails on every subsequent render
  // (a Set of id strings never contains an object) and ALL links get dropped —
  // that's the "Links: 0 / no edges" bug. Extract the id from either shape.
  const linkEndId = (e: unknown): string =>
    e && typeof e === 'object' ? String((e as { id: unknown }).id) : String(e);

  // A link is lineage (event→event provenance) when the backend stamps confidence
  // 1 (parent→child). Drives teal styling, curvature, particles + arrowheads, and
  // the d3 link distance below.
  const isLineage = (l: { confidence?: number }): boolean => (l.confidence ?? 0) >= 0.999;

  // Build the rendered node/link set in three passes:
  //   1. entity-type filter (search no longer filters — it highlights + centers).
  //   2. keep only links whose BOTH ends survived the filter (mutation-safe ids).
  //   3. declutter by degree: drop isolated (deg 0) and, if enabled, weak leaf
  //      EVENT nodes (deg 1), recomputing the link set after each prune so the
  //      degree map and the rendered edges stay consistent.
  const { filteredNodes, filteredLinks } = useMemo(() => {
    // Pass 1 — entity-type filter only.
    let nodes = data.nodes.filter((n) => {
      if (entityTypeFilter !== 'all' && n.type === 'entity' && n.entityType !== entityTypeFilter) return false;
      return true;
    });

    // Helper: keep links wholly inside the current node set, and compute degree.
    const linksWithin = (ns: GraphNode[]): { links: GraphLink[]; deg: Map<string, number> } => {
      const ids = new Set(ns.map((n) => n.id));
      const links = data.links.filter((l) => ids.has(linkEndId(l.source)) && ids.has(linkEndId(l.target)));
      const deg = new Map<string, number>();
      for (const l of links) {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        deg.set(s, (deg.get(s) ?? 0) + 1);
        deg.set(t, (deg.get(t) ?? 0) + 1);
      }
      return { links, deg };
    };

    let { links, deg } = linksWithin(nodes);

    // Pass 3a — hide isolated (degree-0) nodes. Default ON.
    if (hideIsolated) {
      nodes = nodes.filter((n) => (deg.get(n.id) ?? 0) > 0);
      ({ links, deg } = linksWithin(nodes));
    }

    // Pass 3b — hide weak: drop degree-1 leaf EVENT nodes (single-entity flowers),
    // keeping the connected backbone. Recompute again so a node that becomes
    // isolated after its leaf is removed is handled consistently with hideIsolated.
    if (hideWeak) {
      nodes = nodes.filter((n) => !(n.type === 'event' && (deg.get(n.id) ?? 0) <= 1));
      ({ links, deg } = linksWithin(nodes));
      if (hideIsolated) {
        nodes = nodes.filter((n) => (deg.get(n.id) ?? 0) > 0);
        ({ links } = linksWithin(nodes));
      }
    }

    return { filteredNodes: nodes, filteredLinks: links };
  }, [data, entityTypeFilter, hideIsolated, hideWeak]);

  // Stable graphData reference so ForceGraph only re-processes (and re-mutates)
  // when the filtered set actually changes — not on every unrelated re-render.
  const graphData = useMemo(() => ({ nodes: filteredNodes, links: filteredLinks }), [filteredNodes, filteredLinks]);

  const entityTypes = useMemo(
    () => [...new Set(data.nodes.filter((n) => n.type === 'entity').map((n) => n.entityType).filter(Boolean))],
    [data],
  );

  // Node degree (link count) — drives node size so hubs stand out, and gates
  // labels so dense areas aren't unreadable.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of filteredLinks) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      d.set(s, (d.get(s) ?? 0) + 1);
      d.set(t, (d.get(t) ?? 0) + 1);
    }
    return d;
  }, [filteredLinks]);

  // Fast id lookup so detail-row clicks can decide whether to pivot+center on an
  // in-view node (vs. just selecting an off-graph one).
  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode & { x?: number; y?: number }>();
    for (const n of filteredNodes) m.set(n.id, n as GraphNode & { x?: number; y?: number });
    return m;
  }, [filteredNodes]);

  // DATA-DRIVEN LEGEND — tally entity buckets + event kinds actually present in
  // the rendered set so the legend reflects the view, not the theme's full map.
  // Entity buckets reuse entityBucket()→entityColors, the SAME mapping the canvas
  // uses, so swatch color == node color by construction.
  const legend = useMemo(() => {
    const buckets = new Map<EntityBucket, number>();
    const kinds = new Map<string, number>();
    for (const n of filteredNodes) {
      if (n.type === 'entity') {
        const b = entityBucket(n.entityType);
        buckets.set(b, (buckets.get(b) ?? 0) + 1);
      } else {
        const k = n.kind || 'event';
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
    }
    const entityRows = [...buckets.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([bucket, count]) => ({ key: bucket, count, color: entityColors[bucket] ?? entityColors.default }));
    const eventRows = [...kinds.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ key: kind, count, color: kindColors[kind] || EVENT_RING_COLOR }));
    return { entityRows, eventRows };
  }, [filteredNodes]);

  // Search no longer prunes the graph — it highlights matching nodes (ring) and
  // centers the view on the first match. Empty query = no matches highlighted.
  const matchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return new Set<string>();
    return new Set(
      filteredNodes
        .filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
        .map((n) => n.id),
    );
  }, [filteredNodes, searchQuery]);

  // FOCUS MODE: when a node is selected, compute its direct (1-hop) neighbor set
  // from the (mutation-safe) links so we can dim everything else. Includes the
  // selected node itself. Empty when nothing is selected (no dimming).
  const focusIds = useMemo(() => {
    if (!selectedNode) return null;
    const set = new Set<string>([selectedNode.id]);
    for (const l of filteredLinks) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      if (s === selectedNode.id) set.add(t);
      else if (t === selectedNode.id) set.add(s);
    }
    return set;
  }, [selectedNode, filteredLinks]);

  // SEARCH-TO-CENTER: when the query produces matches, pan the camera to the
  // first match and nudge the zoom in so it's visibly framed. Debounced via the
  // effect dependency on the (memoized) match set so it fires on each new query,
  // not on every render. The node's x/y are populated by the force engine.
  useEffect(() => {
    if (!matchIds.size || !fgRef.current) return;
    const first = filteredNodes.find((n) => matchIds.has(n.id)) as (GraphNode & { x?: number; y?: number }) | undefined;
    if (!first || typeof first.x !== 'number' || typeof first.y !== 'number') return;
    const t = setTimeout(() => {
      fgRef.current?.centerAt(first.x, first.y, 600);
      fgRef.current?.zoom(Math.max(2.4, fgRef.current.zoom?.() ?? 1), 600);
    }, 60);
    return () => clearTimeout(t);
  }, [matchIds, filteredNodes]);

  // LAYOUT — tune d3 forces for separation once the engine + data exist. Stronger
  // charge with a capped distanceMax keeps it from exploding; shorter link
  // distances for lineage edges keep provenance chains tight; a collide force
  // (sized off nodeRadius) stops disc overlap. Reheat so the new forces take.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || typeof fg.d3Force !== 'function') return;
    if (!graphData.nodes.length) return;

    fg.d3Force('charge')?.strength(-90).distanceMax(380);
    fg.d3Force('link')
      ?.distance((l: any) => (isLineage(l) ? 26 : 40))
      .strength(0.7);

    // Collide force: react-force-graph re-exports d3-force on the component
    // constructor (ForceGraphMethods) but NOT on the instance, so the safe,
    // dependency-free way to get forceCollide is the d3-force-3d module the
    // library already bundles. We avoid a hard top-level import (which would
    // bloat the eager bundle and risk a missing-dep build break) by attempting
    // a couple of access paths and degrading gracefully: if none resolve we
    // still rely on the increased charge + nodeRelSize for visual separation.
    try {
      const ctor: any = fg.constructor;
      const collideFactory =
        ctor?.forceCollide || (typeof window !== 'undefined' && (window as any).d3?.forceCollide);
      if (typeof collideFactory === 'function') {
        fg.d3Force('collide', collideFactory((n: any) => nodeRadius(n) + 2).strength(0.85));
      }
    } catch (err) {
      // Non-fatal — separation still comes from charge/link distance.
      console.debug('collide force unavailable:', err);
    }

    fg.d3ReheatSimulation?.();
    // nodeRadius is stable-ish (depends on degree); re-run when the data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  // Zoom controls wired to the imperative ForceGraph handle.
  const zoomFit = useCallback(() => fgRef.current?.zoomToFit(400, 60), []);
  const zoomBy = useCallback((factor: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    const cur = typeof fg.zoom === 'function' ? fg.zoom() : 1;
    fg.zoom(cur * factor, 300);
  }, []);

  const nodeFill = useCallback(
    (n: GraphNode): string => (n.type === 'entity' ? entityColor(n.entityType) : EVENT_RING_COLOR),
    [],
  );
  // Entities are the structure → larger base (3.5) and filled discs. Events are
  // hollow rings → smaller base (2). Both grow with degree so hubs read.
  const nodeRadius = useCallback(
    (n: GraphNode): number => (n.type === 'entity' ? 3.5 : 2) + Math.min(6, Math.sqrt(degree.get(n.id) ?? 0)),
    [degree],
  );

  // Pivot the selection to another node (detail-row click). If it's in the
  // current view, center the camera on it; otherwise just select it.
  const pivotTo = useCallback(
    (node: GraphNode) => {
      setSelectedNode(node);
      const inView = nodeById.get(node.id);
      if (inView && typeof inView.x === 'number' && typeof inView.y === 'number') {
        fgRef.current?.centerAt(inView.x, inView.y, 600);
        fgRef.current?.zoom(Math.max(2.4, fgRef.current.zoom?.() ?? 1), 600);
      }
    },
    [nodeById],
  );

  const hasData = !loading && filteredNodes.length > 0;
  const isEmpty = !loading && filteredNodes.length === 0 && !error;

  const selectedIsEvent = selectedNode?.type === 'event';
  const selectedIsEntity = selectedNode?.type === 'entity';
  const hasLineage = !!lineage && (lineage.parents.length > 0 || lineage.children.length > 0);
  const selectedDegree = selectedNode ? degree.get(selectedNode.id) ?? 0 : 0;

  return (
    <div style={{ display: 'flex', height: '100%', background: colors.base }}>
      {/* Sidebar */}
      <div style={{ width: 280, padding: 16, background: colors.panel, color: colors.text, overflow: 'auto', borderRight: `1px solid ${colors.border}`, flexShrink: 0 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>🔗 Intelligence Graph</h2>

        <div style={{ marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.base, color: colors.text, fontSize: 13 }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <select
            value={entityTypeFilter}
            onChange={(e) => setEntityTypeFilter(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.base, color: colors.text, fontSize: 13 }}
          >
            <option value="all">All entity types</option>
            {entityTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        {/* 006 graph toggles — re-fetch on change via the loadNetwork effect. */}
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={entityOnly}
              onChange={(e) => setEntityOnly(e.target.checked)}
              disabled={loading}
            />
            <span>Entity-only<span style={{ color: colors.dim }}> (collapse descriptors)</span></span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeLineage}
              onChange={(e) => setIncludeLineage(e.target.checked)}
              disabled={loading}
            />
            <span>Include lineage<span style={{ color: colors.dim }}> (event→event)</span></span>
          </label>
        </div>

        {/* Declutter toggles — applied client-side, no re-fetch. */}
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h4 style={{ margin: '0 0 0', fontSize: 12, color: colors.dim }}>Declutter</h4>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={hideIsolated}
              onChange={(e) => setHideIsolated(e.target.checked)}
            />
            <span>Hide isolated<span style={{ color: colors.dim }}> (no links)</span></span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={hideWeak}
              onChange={(e) => setHideWeak(e.target.checked)}
            />
            <span>Hide weak<span style={{ color: colors.dim }}> (leaf events)</span></span>
          </label>
        </div>

        <div style={{ fontSize: 12, color: colors.dim, marginBottom: 12 }}>
          Nodes: {filteredNodes.length} | Links: {filteredLinks.length}
          {matchIds.size > 0 && (
            <span style={{ color: colors.teal }}> · {matchIds.size} match{matchIds.size === 1 ? '' : 'es'}</span>
          )}
          {selectedNode && (
            <span style={{ color: colors.info }}> · focus on</span>
          )}
        </div>

        {selectedNode && (
          <button
            onClick={() => setSelectedNode(null)}
            style={{ width: '100%', padding: '6px 10px', background: colors.base, color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 4, cursor: 'pointer', marginBottom: 12, fontSize: 12 }}
          >
            ✕ Clear focus
          </button>
        )}

        <button
          onClick={loadNetwork}
          disabled={loading}
          style={{ width: '100%', padding: '8px', background: colors.info, color: colors.accent, border: 'none', borderRadius: 4, cursor: 'pointer', marginBottom: 16, opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Loading...' : '🔄 Refresh'}
        </button>

        {/* 006 export buttons. GEXF + Sigma export the current view; Tree needs a root. */}
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 12, color: colors.dim }}>Export</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <a href={graphExportUrl('gexf', graphOpts)} download style={exportLinkStyle(false)}>
              ⬇ GEXF (Gephi)
            </a>
            <a href={graphExportUrl('sigma', graphOpts)} download style={exportLinkStyle(false)}>
              ⬇ Sigma JSON
            </a>
            <a
              href={selectedNode ? graphExportUrl('tree', { ...graphOpts, root: selectedNode.id }) : undefined}
              download
              aria-disabled={!selectedNode}
              style={exportLinkStyle(!selectedNode)}
              title={selectedNode ? `Tree rooted at ${selectedNode.id}` : 'Select a node to export its tree'}
            >
              ⬇ Tree {selectedNode ? '(from selection)' : '(select a node)'}
            </a>
          </div>
        </div>

        {selectedNode && (
          <div style={{ background: colors.base, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 16, border: `1px solid ${colors.border}` }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>
              {selectedNode.type === 'event' ? '📄 Event' : '🔖 Entity'}
              <span style={{ color: colors.dim, fontWeight: 400 }}> · deg {selectedDegree}</span>
            </h3>
            <p style={{ margin: '4px 0', wordBreak: 'break-all' }}><strong>ID:</strong> {selectedNode.id}</p>
            <p style={{ margin: '4px 0' }}><strong>Label:</strong> {selectedNode.label}</p>
            {selectedNode.kind && (
              <p style={{ margin: '4px 0' }}>
                <strong>Kind:</strong>{' '}
                <span style={{ color: kindColors[selectedNode.kind] || colors.accent }}>{selectedNode.kind}</span>
              </p>
            )}
            {selectedNode.entityType && (
              <p style={{ margin: '4px 0' }}>
                <strong>Type:</strong>{' '}
                <span style={{ color: entityColor(selectedNode.entityType) }}>{selectedNode.entityType}</span>
              </p>
            )}

            {/* ENTITY drill-down — stats, connected events, co-occurring entities. */}
            {selectedIsEntity && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
                {entityDetailLoading ? (
                  <div style={{ fontSize: 12, color: colors.dim }}>Loading entity…</div>
                ) : entityDetail ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <EntityStats detail={entityDetail} />
                    <DetailGroup title="Events" count={entityDetail.events.length}>
                      {entityDetail.events.map((ev) => (
                        <EventRow
                          key={ev.eventId}
                          ev={ev}
                          onClick={() =>
                            pivotTo({ id: ev.eventId, type: 'event', label: ev.title || ev.eventId, kind: undefined })
                          }
                        />
                      ))}
                    </DetailGroup>
                    <DetailGroup title="Related entities" count={entityDetail.relatedEntities.length}>
                      {entityDetail.relatedEntities.map((re) => (
                        <RelatedEntityRow
                          key={re.id}
                          re={re}
                          onClick={() =>
                            pivotTo({ id: re.id, type: 'entity', label: re.value || re.id, entityType: re.type })
                          }
                        />
                      ))}
                    </DetailGroup>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: colors.muted }}>no detail</div>
                )}
              </div>
            )}

            {/* EVENT drill-down — extracted entities (above the lineage panel). */}
            {selectedIsEvent && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
                <h4 style={{ margin: '0 0 6px', fontSize: 12, color: colors.dim }}>Entities</h4>
                {eventDetailLoading ? (
                  <div style={{ fontSize: 12, color: colors.dim }}>Loading entities…</div>
                ) : eventDetail && eventDetail.entities.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {eventDetail.entities.map((en) => (
                      <button
                        key={en.id}
                        onClick={() => pivotTo({ id: en.id, type: 'entity', label: en.value || en.id, entityType: en.type })}
                        title={en.context || `${en.type} · ${en.value}`}
                        style={chipBtnStyle(entityColor(en.type))}
                      >
                        <span style={{ color: entityColor(en.type) }}>{en.value || en.id}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: colors.muted }}>no entities</div>
                )}
              </div>
            )}

            {/* 006 lineage drill-down — only meaningful for event nodes. */}
            {selectedIsEvent && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
                <h4 style={{ margin: '0 0 6px', fontSize: 12, color: colors.dim }}>Lineage</h4>
                {lineageLoading ? (
                  <div style={{ fontSize: 12, color: colors.dim }}>Loading lineage…</div>
                ) : hasLineage ? (
                  <LineagePanel lineage={lineage!} />
                ) : (
                  <div style={{ fontSize: 12, color: colors.muted }}>no lineage</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* DATA-DRIVEN LEGEND — only buckets/kinds present in the rendered view,
            with live counts. Entity swatch = square disc; event swatch = ring,
            mirroring the canvas shapes. */}
        <div>
          <h4 style={{ margin: '0 0 8px', fontSize: 12, color: colors.dim }}>Legend</h4>
          {legend.entityRows.length === 0 && legend.eventRows.length === 0 && (
            <div style={{ fontSize: 11, color: colors.muted }}>no nodes in view</div>
          )}
          {legend.eventRows.map((row) => (
            <div key={`k-${row.key}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', border: `2px solid ${row.color}`, background: 'transparent', display: 'inline-block', boxSizing: 'border-box' }} />
              <span style={{ flex: 1 }}>{row.key}</span>
              <span style={{ color: colors.dim }}>{row.count}</span>
            </div>
          ))}
          {legend.entityRows.map((row) => (
            <div key={`e-${row.key}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: row.color, display: 'inline-block' }} />
              <span style={{ flex: 1 }}>{row.key}</span>
              <span style={{ color: colors.dim }}>{row.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Graph canvas */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: colors.dim, gap: 12, zIndex: 10 }}>
            <div style={{ width: 32, height: 32, border: `3px solid ${colors.border}`, borderTopColor: colors.info, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div>Loading graph...</div>
          </div>
        )}

        {error && <GraphError message={error} />}

        {isEmpty && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: colors.dim, gap: 16, padding: 40 }}>
            <div style={{ fontSize: 56 }}>🔗</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: colors.text }}>Graph is empty</div>
            <div style={{ fontSize: 14, maxWidth: 400, textAlign: 'center', lineHeight: 1.6, color: colors.dim }}>
              Entities (IPs, domains, emails, hashes, CVEs) are extracted automatically from event content as new events are ingested.
              <br /><br />
              Once events flow through the pipeline, they will appear here connected to their extracted entities.
            </div>
            <button
              onClick={loadNetwork}
              style={{ padding: '8px 20px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text, cursor: 'pointer', fontSize: 13, marginTop: 8 }}
            >
              🔄 Check again
            </button>
          </div>
        )}

        {hasData && (
          <>
            {/* Zoom-control cluster, absolutely positioned over the canvas. */}
            <div style={zoomClusterStyle}>
              <button style={zoomBtnStyle} title="Fit graph to view" onClick={zoomFit}>⤢</button>
              <button style={zoomBtnStyle} title="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
              <button style={zoomBtnStyle} title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>−</button>
            </div>

            {/* Focus-mode hint, shown while a node is selected. */}
            {selectedNode && (
              <button
                onClick={() => setSelectedNode(null)}
                style={focusHintStyle}
                title="Exit focus mode"
              >
                Focusing on {selectedNode.label.length > 22 ? `${selectedNode.label.slice(0, 21)}…` : selectedNode.label} · ✕ clear
              </button>
            )}

            <Suspense fallback={<GraphFallback />}>
              <ErrorBoundary fallback={<GraphError message="Graph rendering failed" />}>
                <ForceGraph2D
                  ref={fgRef}
                  graphData={graphData}
                  nodeRelSize={4}
                  d3VelocityDecay={0.3}
                  // HOVER TOOLTIP — HTML string. Label is free LLM text → escape
                  // &<>". A colored type/kind chip + degree (+ event count for
                  // entities) gives at-a-glance context without extra state.
                  nodeLabel={(n: any) => {
                    const deg = degree.get(n.id) ?? 0;
                    const safeLabel = escapeHtml(n.label ?? n.id);
                    if (n.type === 'entity') {
                      const c = entityColor(n.entityType);
                      const chip = escapeHtml(n.entityType || 'entity');
                      return (
                        `<div style="font:12px sans-serif;background:${colors.panel};color:${colors.text};` +
                        `border:1px solid ${colors.border};border-radius:4px;padding:6px 8px;max-width:280px">` +
                        `<div style="font-weight:600;word-break:break-word">${safeLabel}</div>` +
                        `<div style="margin-top:4px;font-size:10px">` +
                        `<span style="color:${c}">▪ ${chip}</span>` +
                        `<span style="color:${colors.dim}"> · deg ${deg}</span></div></div>`
                      );
                    }
                    const k = n.kind || 'event';
                    const c = kindColors[k] || EVENT_RING_COLOR;
                    const chip = escapeHtml(k);
                    return (
                      `<div style="font:12px sans-serif;background:${colors.panel};color:${colors.text};` +
                      `border:1px solid ${colors.border};border-radius:4px;padding:6px 8px;max-width:280px">` +
                      `<div style="font-weight:600;word-break:break-word">${safeLabel}</div>` +
                      `<div style="margin-top:4px;font-size:10px">` +
                      `<span style="color:${c}">○ ${chip}</span>` +
                      `<span style="color:${colors.dim}"> · deg ${deg}</span></div></div>`
                    );
                  }}
                  nodeVal={(n: any) => nodeRadius(n)}
                  // LINEAGE EDGES are teal + curved + arrowed; entity-event links
                  // are thinned to cut noise. Focus mode still gates brightness.
                  linkColor={(l: any) => {
                    const lineageLink = isLineage(l);
                    if (focusIds) {
                      const s = linkEndId(l.source);
                      const t = linkEndId(l.target);
                      const lit = focusIds.has(s) && focusIds.has(t);
                      if (lineageLink) return `rgba(${rgb(colors.teal)}, ${lit ? 0.85 : 0.1})`;
                      return `rgba(${rgb(colors.text)}, ${lit ? 0.3 : 0.04})`;
                    }
                    return lineageLink ? `rgba(${rgb(colors.teal)}, 0.7)` : `rgba(${rgb(colors.text)}, 0.14)`;
                  }}
                  linkWidth={(l: any) => (isLineage(l) ? 1.5 : 0.6)}
                  linkCurvature={(l: any) => (isLineage(l) ? 0.25 : 0)}
                  linkDirectionalArrowLength={(l: any) => (isLineage(l) ? 3 : 0)}
                  linkDirectionalArrowRelPos={1}
                  linkDirectionalArrowColor={() => colors.teal}
                  // Particles ONLY on lineage edges so CPU stays bounded.
                  linkDirectionalParticles={(l: any) => (isLineage(l) ? 2 : 0)}
                  linkDirectionalParticleWidth={1.6}
                  linkDirectionalParticleColor={() => colors.teal}
                  backgroundColor={colors.base}
                  onNodeClick={(n: any) => setSelectedNode(n as GraphNode)}
                  onBackgroundClick={() => setSelectedNode(null)}
                  nodeCanvasObjectMode={() => 'replace'}
                  nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
                    const r = nodeRadius(n);
                    const isMatch = matchIds.has(n.id);
                    const isEntity = n.type === 'entity';
                    // FOCUS MODE alpha: dim everything outside the 1-hop set.
                    const dimmed = focusIds ? !focusIds.has(n.id) : false;
                    const alpha = dimmed ? 0.12 : 1;
                    ctx.globalAlpha = alpha;

                    const fill = nodeFill(n);
                    const deg = degree.get(n.id) ?? 0;

                    // HUB GLOW — faint concentric ring for well-connected entity
                    // hubs (deg >= 6), drawn BEFORE the node so it reads as a halo.
                    // shadowBlur avoided (too expensive per-frame).
                    if (isEntity && deg >= 6 && !dimmed) {
                      ctx.beginPath();
                      ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI);
                      ctx.strokeStyle = `rgba(${rgb(fill)}, 0.25)`;
                      ctx.lineWidth = 2.5;
                      ctx.stroke();
                    }

                    // NODE SHAPE — entity = filled disc; event = hollow ring with
                    // a very faint fill so dim/hit-testing still works.
                    ctx.beginPath();
                    ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
                    if (isEntity) {
                      ctx.fillStyle = fill;
                      ctx.fill();
                    } else {
                      ctx.fillStyle = `rgba(${rgb(fill)}, 0.15)`;
                      ctx.fill();
                      ctx.lineWidth = Math.max(0.6, 1.4 / scale);
                      ctx.strokeStyle = fill;
                      ctx.stroke();
                    }

                    // Search-match ring (teal) — drawn even when dimmed so the
                    // operator can still spot matches in a focused view.
                    if (isMatch) {
                      ctx.globalAlpha = 1;
                      ctx.lineWidth = 2 / scale;
                      ctx.strokeStyle = colors.teal;
                      ctx.beginPath();
                      ctx.arc(n.x, n.y, r + 2 / scale, 0, 2 * Math.PI);
                      ctx.stroke();
                      ctx.globalAlpha = alpha;
                    }

                    // Selected node gets a white outline.
                    if (selectedNode?.id === n.id) {
                      ctx.globalAlpha = 1;
                      ctx.lineWidth = 2 / scale;
                      ctx.strokeStyle = '#fff';
                      ctx.beginPath();
                      ctx.arc(n.x, n.y, r + 1 / scale, 0, 2 * Math.PI);
                      ctx.stroke();
                      ctx.globalAlpha = alpha;
                    }

                    // Labels: always for ENTITY nodes and hubs (degree >= 5),
                    // zoom-gated for everyone else, plus always for matches. A
                    // dark text-halo (stroke behind fill) keeps them legible
                    // over links. Dimmed nodes don't draw labels (declutter).
                    const alwaysLabel = isEntity || deg >= 5 || isMatch;
                    if (n.label && !dimmed && (alwaysLabel || scale > 1.6)) {
                      const fontSize = Math.max(2.5, 11 / scale);
                      ctx.font = `${fontSize}px sans-serif`;
                      ctx.textAlign = 'left';
                      ctx.textBaseline = 'middle';
                      const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
                      const lx = n.x + r + 1.5;
                      // Halo behind the text.
                      ctx.lineWidth = Math.max(1, 3 / scale);
                      ctx.strokeStyle = `rgba(${rgb(colors.base)}, 0.85)`;
                      ctx.lineJoin = 'round';
                      ctx.strokeText(label, lx, n.y);
                      ctx.fillStyle = isMatch ? colors.teal : `rgba(${rgb(colors.text)}, 0.9)`;
                      ctx.fillText(label, lx, n.y);
                    }
                    ctx.globalAlpha = 1;
                  }}
                  nodePointerAreaPaint={(n: any, color: string, ctx: CanvasRenderingContext2D) => {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(n.x, n.y, nodeRadius(n) + 2, 0, 2 * Math.PI);
                    ctx.fill();
                  }}
                  warmupTicks={20}
                  cooldownTicks={120}
                  onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
                />
              </ErrorBoundary>
            </Suspense>
          </>
        )}
      </div>
    </div>
  );
}

// ----- Detail-panel building blocks (reused for Events/Related/Entities) -----

// Generic collapsible-less group: a "Title (N)" header + a vertical stack of
// rows. Renders nothing when empty. Replaces the bespoke LineageGroup shell.
function DetailGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 11, color: colors.dim, marginBottom: 4 }}>
        {title} ({count})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

const detailRowStyle: React.CSSProperties = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  padding: '6px 8px',
  textAlign: 'left',
  cursor: 'pointer',
  color: colors.text,
  width: '100%',
};

// Small colored type/kind chip button (also used inline for event entities).
function chipBtnStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 6px',
    borderRadius: 4,
    border: `1px solid ${color}`,
    background: colors.panel,
    cursor: 'pointer',
    fontSize: 11,
    color: colors.text,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

// Entity stats block: event count + first/last seen.
function EntityStats({ detail }: { detail: EntityDetail }) {
  const { entity } = detail;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: colors.dim }}>
      <div>
        <span style={{ color: colors.text }}>{entity.eventCount}</span> events
      </div>
      <div>first seen: <span style={{ color: colors.text2 }}>{fmtDate(entity.firstSeenAt)}</span></div>
      <div>last seen: <span style={{ color: colors.text2 }}>{fmtDate(entity.lastSeenAt)}</span></div>
    </div>
  );
}

// One connected-event row (entity drill-down) — clickable to pivot.
function EventRow({ ev, onClick }: { ev: GraphEntityEvent; onClick: () => void }) {
  return (
    <button onClick={onClick} style={detailRowStyle}>
      <div style={{ fontSize: 12, color: colors.text, wordBreak: 'break-word' }}>
        {ev.title || ev.eventId}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, fontSize: 10 }}>
        <span style={{ color: colors.teal }}>{(ev.confidence ?? 0).toFixed(2)}</span>
        {ev.eventAt ? <span style={{ color: colors.muted }}>· {relTime(ev.eventAt)}</span> : null}
      </div>
    </button>
  );
}

// One co-occurring (related) entity row — colored type chip + shared-events badge.
function RelatedEntityRow({ re, onClick }: { re: GraphRelatedEntity; onClick: () => void }) {
  const c = entityColor(re.type);
  return (
    <button onClick={onClick} style={detailRowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 12, color: colors.text, wordBreak: 'break-word', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {re.value || re.id}
        </span>
        <span style={{ color: colors.dim, fontSize: 10, whiteSpace: 'nowrap' }}>×{re.sharedEvents}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 10 }}>
        <span style={{ color: c }}>▪ {re.type}</span>
      </div>
    </button>
  );
}

// Renders the parents/children of the selected event's provenance lineage.
function LineagePanel({ lineage }: { lineage: Lineage }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <LineageGroup title="Parents" neighbors={lineage.parents} />
      <LineageGroup title="Children" neighbors={lineage.children} />
    </div>
  );
}

function LineageGroup({ title, neighbors }: { title: string; neighbors: LineageNeighbor[] }) {
  return (
    <DetailGroup title={title} count={neighbors.length}>
      {neighbors.map((n) => (
        <div
          key={`${title}-${n.eventId}-${n.relation}`}
          style={{ background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 4, padding: '6px 8px' }}
        >
          <div style={{ fontSize: 12, color: colors.text, wordBreak: 'break-word' }}>
            {n.title || n.eventId}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, fontSize: 10 }}>
            {n.kind && (
              <span style={{ color: kindColors[n.kind] || colors.accent }}>{n.kind}</span>
            )}
            <span style={{ color: colors.teal }}>{n.relation}</span>
            {n.processor && <span style={{ color: colors.muted }}>· {n.processor}</span>}
          </div>
        </div>
      ))}
    </DetailGroup>
  );
}

// Simple error boundary for the graph component
class ErrorBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
