import React, { useEffect, useState, useCallback, useMemo, Suspense, lazy, useRef } from 'react';
import { Command } from 'cmdk';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { colors, kindColors, entityColors, rgb } from '../lib/theme.js';
import {
  getGraphNetwork, getLineage, getGraphEntity, getGraphEvent, graphExportUrl,
  type GraphOpts, type LineageNeighbor,
  type GraphEntity, type GraphEntityEvent, type GraphRelatedEntity, type GraphEventEntity,
} from '../lib/api.js';
import type { IntelEvent } from '../lib/types.js';

const ForceGraph2D = lazy(() => import('react-force-graph-2d'));

// ---- Louvain clustering: translucent convex-hull regions behind the nodes ----
// Distinct hues for communities, kept SEPARATE from the entity-type colors — the
// nodes stay colored by type while the hulls show community structure on top.
const CLUSTER_PALETTE = [
  '#44ffcc', '#ff8800', '#b48cff', '#44ff88', '#3388ff', '#ff4488',
  '#ffd24a', '#44aaff', '#ff6644', '#88ddaa', '#cc88ff', '#aaff44',
];
function clusterColor(c: number): string {
  const i = ((c % CLUSTER_PALETTE.length) + CLUSTER_PALETTE.length) % CLUSTER_PALETTE.length;
  return CLUSTER_PALETTE[i];
}
// Andrew's monotone-chain convex hull (CCW). Returns the input for < 3 points.
function convexHull(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (pts.length < 3) return pts.slice();
  const p = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

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

// ---- Floating canvas toolbar (Phase 2 chrome) ----
// A dark rounded pill, top-right over the canvas, replacing the old bare zoom
// cluster. Quick-access buttons mirror the canonical sidebar checkboxes (same
// state setters), so the toolbar never diverges from the source of truth.
const toolbarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: 4,
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  background: colors.panel,
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
};
const toolbarDividerStyle: React.CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  margin: '2px 3px',
  background: colors.border,
};
// Toolbar icon button — `active` paints the wm-hover background + accent text so
// toggle state (clusters on, color-by-cluster) reads at a glance.
function toolbarBtnStyle(active = false, disabled = false): React.CSSProperties {
  return {
    minWidth: 28,
    height: 28,
    padding: '0 7px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 5,
    border: `1px solid ${active ? colors.borderStrong : 'transparent'}`,
    background: active ? colors.hover : 'transparent',
    color: disabled ? colors.muted : active ? colors.text : colors.text2,
    fontSize: 13,
    lineHeight: 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
  };
}

// ---- Command palette (⌘K) styling ----
// cmdk ships headless DOM (data-attribute hooks, no styles). We scope a <style>
// block under `.wm-cmdk` and target cmdk's `[cmdk-*]` selectors + the active item
// via `[cmdk-item][data-selected="true"]` (cmdk stamps data-selected on the item
// under the keyboard/pointer cursor). Keeps the dark wm-* look; keyboard nav is
// handled entirely by cmdk — we don't trap arrow/enter.
const PALETTE_CSS = `
.wm-cmdk { display: flex; flex-direction: column; max-height: 60vh; }
.wm-cmdk [cmdk-input] {
  width: 100%;
  box-sizing: border-box;
  padding: 14px 16px;
  border: none;
  border-bottom: 1px solid ${colors.border};
  background: transparent;
  color: ${colors.text};
  font-size: 15px;
  outline: none;
}
.wm-cmdk [cmdk-input]::placeholder { color: ${colors.muted}; }
.wm-cmdk [cmdk-list] {
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px;
  flex: 1;
  min-height: 0;
}
.wm-cmdk [cmdk-group-heading] {
  padding: 8px 8px 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${colors.dim};
}
.wm-cmdk [cmdk-item] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 5px;
  border-left: 2px solid transparent;
  color: ${colors.text2};
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.wm-cmdk [cmdk-item][data-selected="true"] {
  background: ${colors.hover};
  border-left-color: ${colors.teal};
  color: ${colors.text};
}
.wm-cmdk [cmdk-empty] {
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  color: ${colors.muted};
}
`;

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
  // Louvain community hulls drawn behind the nodes (cluster structure).
  const [showClusters, setShowClusters] = useState(true);
  // Color nodes by community instead of by entity type.
  const [colorByCluster, setColorByCluster] = useState(false);
  // 006 lineage drill-down for the selected EVENT node.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  // 006 node drill-down — entity stats/events/related, and event extracted entities.
  const [entityDetail, setEntityDetail] = useState<EntityDetail | null>(null);
  const [entityDetailLoading, setEntityDetailLoading] = useState(false);
  const [eventDetail, setEventDetail] = useState<EventDetail | null>(null);
  const [eventDetailLoading, setEventDetailLoading] = useState(false);
  // ⌘K / Ctrl-K command palette (Phase 2 chrome) — quick fuzzy jump to any node
  // plus a few graph actions, layered as a modal over the whole component.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // LASSO / rubber-band multi-select. lassoMode arms the overlay; lassoRect holds
  // the live drag rectangle (OVERLAY-LOCAL pixel coords) while dragging; selectedIds
  // is the resolved multi-selection. The overlay div sits exactly over the canvas so
  // graph2ScreenCoords() (canvas pixels) aligns 1:1 with the rect's local coords.
  const [lassoMode, setLassoMode] = useState(false);
  const [lassoRect, setLassoRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lassoLayerRef = useRef<HTMLDivElement | null>(null);
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

  // LOUVAIN community detection (graphology) over the RENDERED graph. Nodes keep
  // their entity-type colors; communities surface as translucent convex-hull
  // regions behind the nodes, so cluster structure reads without losing meaning.
  const communities = useMemo(() => {
    const g = new Graph({ type: 'undirected' });
    for (const n of filteredNodes) if (!g.hasNode(n.id)) g.addNode(n.id);
    for (const l of filteredLinks) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      if (s !== t && g.hasNode(s) && g.hasNode(t) && !g.hasEdge(s, t)) g.addEdge(s, t);
    }
    if (g.order === 0 || g.size === 0) return new Map<string, number>();
    try {
      const assignment = louvain(g) as Record<string, number>;
      return new Map<string, number>(Object.entries(assignment));
    } catch {
      return new Map<string, number>();
    }
  }, [filteredNodes, filteredLinks]);

  const clusterCount = useMemo(() => new Set(communities.values()).size, [communities]);

  // Per-community info: member count + the top (highest-degree) ENTITY's label —
  // used for the on-canvas region labels, the cluster legend, and cluster coloring.
  const communityInfo = useMemo(() => {
    const size = new Map<number, number>();
    const best = new Map<number, { label: string; deg: number }>();
    for (const n of filteredNodes) {
      const c = communities.get(n.id);
      if (c == null) continue;
      size.set(c, (size.get(c) ?? 0) + 1);
      if (n.type === 'entity') {
        const deg = degree.get(n.id) ?? 0;
        const cur = best.get(c);
        if (!cur || deg > cur.deg) best.set(c, { label: n.label, deg });
      }
    }
    const out = new Map<number, { label: string; size: number }>();
    for (const [c, s] of size) out.set(c, { label: best.get(c)?.label ?? `cluster ${c}`, size: s });
    return out;
  }, [filteredNodes, communities, degree]);

  // Sorted cluster rows for the legend (largest first), each with its hue.
  const clusterRows = useMemo(
    () =>
      [...communityInfo.entries()]
        .sort((a, b) => b[1].size - a[1].size)
        .map(([c, info]) => ({ key: info.label, count: info.size, color: clusterColor(c) })),
    [communityInfo],
  );

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

  // LASSO SELECTION SUMMARY — derived from selectedIds over the rendered set:
  // entity buckets (colored chip + count), event kinds (colored chip + count),
  // and the top entities by degree for the quick-chip strip. Recomputed only when
  // the selection or the rendered nodes change.
  const selectionSummary = useMemo(() => {
    if (selectedIds.size === 0) {
      return { entityBuckets: [], eventKinds: [], topEntities: [], total: 0 };
    }
    const buckets = new Map<EntityBucket, number>();
    const kinds = new Map<string, number>();
    const entities: Array<{ node: GraphNode; deg: number }> = [];
    let total = 0;
    for (const n of filteredNodes) {
      if (!selectedIds.has(n.id)) continue;
      total++;
      if (n.type === 'entity') {
        const b = entityBucket(n.entityType);
        buckets.set(b, (buckets.get(b) ?? 0) + 1);
        entities.push({ node: n, deg: degree.get(n.id) ?? 0 });
      } else {
        const k = n.kind || 'event';
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
    }
    const entityBuckets = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([bucket, count]) => ({ key: bucket, count, color: entityColors[bucket] ?? entityColors.default }));
    const eventKinds = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => ({ key: kind, count, color: kindColors[kind] || EVENT_RING_COLOR }));
    const topEntities = entities.sort((a, b) => b.deg - a.deg).slice(0, 8).map((e) => e.node);
    return { entityBuckets, eventKinds, topEntities, total };
  }, [selectedIds, filteredNodes, degree]);

  // FINALIZE LASSO — translate the drag rectangle into a node selection. Treated
  // as a real lasso only if it spans > ~4px in BOTH dims; a smaller box is a click,
  // which clears the selection. For each rendered node with finite graph coords we
  // map graph→screen via fgRef.graph2ScreenCoords (CANVAS pixels) which line up with
  // the overlay-local rect coords (the overlay is positioned exactly over the canvas).
  const finalizeLasso = useCallback(
    (rect: { x0: number; y0: number; x1: number; y1: number }) => {
      const minX = Math.min(rect.x0, rect.x1);
      const maxX = Math.max(rect.x0, rect.x1);
      const minY = Math.min(rect.y0, rect.y1);
      const maxY = Math.max(rect.y0, rect.y1);
      // Tiny box → treat as a click: clear the multi-selection.
      if (maxX - minX < 4 || maxY - minY < 4) {
        setSelectedIds((prev) => (prev.size ? new Set() : prev));
        return;
      }
      const fg = fgRef.current;
      if (!fg || typeof fg.graph2ScreenCoords !== 'function') return;
      const next = new Set<string>();
      for (const n of filteredNodes as Array<GraphNode & { x?: number; y?: number }>) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number' || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const sc = fg.graph2ScreenCoords(n.x, n.y);
        if (!sc || !Number.isFinite(sc.x) || !Number.isFinite(sc.y)) continue;
        if (sc.x >= minX && sc.x <= maxX && sc.y >= minY && sc.y <= maxY) next.add(n.id);
      }
      setSelectedIds(next);
    },
    [filteredNodes],
  );

  // Pointer handlers for the lasso overlay. Coordinates are OVERLAY-LOCAL (relative
  // to the overlay's bounding rect = the canvas), which matches graph2ScreenCoords.
  const lassoLocalPoint = useCallback((e: React.MouseEvent) => {
    const rect = lassoLayerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const onLassoMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!lassoMode || e.button !== 0) return;
      const p = lassoLocalPoint(e);
      setLassoRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    },
    [lassoMode, lassoLocalPoint],
  );

  const onLassoMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!lassoMode) return;
      setLassoRect((prev) => {
        if (!prev) return prev;
        const p = lassoLocalPoint(e);
        return { ...prev, x1: p.x, y1: p.y };
      });
    },
    [lassoMode, lassoLocalPoint],
  );

  const finishLassoDrag = useCallback(() => {
    setLassoRect((prev) => {
      if (prev) finalizeLasso(prev);
      return null;
    });
  }, [finalizeLasso]);

  // EXPORT the current selection as CSV (client-side Blob download). Columns:
  // id,type,label,kind_or_entityType,degree. Cells are RFC-4180-escaped: wrapped in
  // quotes with inner quotes doubled when they contain a comma, quote, or newline.
  const exportSelectionCsv = useCallback(() => {
    if (selectedIds.size === 0) return;
    const esc = (v: string | number): string => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['id', 'type', 'label', 'kind_or_entityType', 'degree'];
    const rows = [header.join(',')];
    for (const n of filteredNodes) {
      if (!selectedIds.has(n.id)) continue;
      const kindOrType = n.type === 'entity' ? n.entityType ?? '' : n.kind ?? '';
      rows.push([esc(n.id), esc(n.type), esc(n.label), esc(kindOrType), esc(degree.get(n.id) ?? 0)].join(','));
    }
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'graph-selection.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [selectedIds, filteredNodes, degree]);

  // Clear the multi-selection (and, by request, drop out of lasso mode).
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLassoMode(false);
  }, []);

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
    (n: GraphNode): string => {
      if (colorByCluster) {
        const c = communities.get(n.id);
        if (c != null) return clusterColor(c);
      }
      return n.type === 'entity' ? entityColor(n.entityType) : EVENT_RING_COLOR;
    },
    [colorByCluster, communities],
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

  // ⌘K / Ctrl-K toggles the command palette; Escape closes it. Registered once on
  // the window so it works regardless of focus. preventDefault stops the browser's
  // own ⌘K (focus address bar / search) from stealing the chord.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Cap the palette node list for fuzzy-match perf on large graphs. cmdk renders
  // every Item up front, so an unbounded list on a 1000+ node graph would stutter
  // the open animation. 400 comfortably covers the default limit:100 fetch.
  const PALETTE_NODE_CAP = 400;
  const paletteNodes = useMemo(() => filteredNodes.slice(0, PALETTE_NODE_CAP), [filteredNodes]);

  const hasData = !loading && filteredNodes.length > 0;
  const isEmpty = !loading && filteredNodes.length === 0 && !error;

  const selectedIsEvent = selectedNode?.type === 'event';
  const selectedIsEntity = selectedNode?.type === 'entity';
  const hasLineage = !!lineage && (lineage.parents.length > 0 || lineage.children.length > 0);
  const selectedDegree = selectedNode ? degree.get(selectedNode.id) ?? 0 : 0;

  return (
    <div style={{ display: 'flex', height: '100%', background: colors.base }}>
      {/* ⌘K command palette — modal overlay above the entire console. */}
      {paletteOpen && (
        <CommandPalette
          nodes={paletteNodes}
          degree={degree}
          onClose={() => setPaletteOpen(false)}
          onRunAction={(fn) => {
            fn();
            setPaletteOpen(false);
          }}
          onSelectNode={(node) => {
            setPaletteOpen(false);
            pivotTo(node);
          }}
          actions={[
            { label: 'Fit to view', hint: 'zoom', run: zoomFit },
            { label: 'Toggle cluster hulls', hint: showClusters ? 'on' : 'off', run: () => setShowClusters((v) => !v) },
            { label: 'Color by cluster / type', hint: colorByCluster ? 'cluster' : 'type', run: () => setColorByCluster((v) => !v) },
            { label: 'Clear selection & focus', hint: '', run: () => setSelectedNode(null) },
          ]}
        />
      )}

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

        {/* LASSO SELECTION PANEL — only when a multi-selection is active. Shows the
            count, an entity-bucket + event-kind breakdown, the top entities, and
            Center / Export CSV / Clear actions. */}
        {selectedIds.size > 0 && (
          <div style={{ background: colors.base, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 16, border: `1px solid ${colors.teal}` }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: colors.teal }}>⬚</span>
              {selectionSummary.total} selected
            </h3>

            {/* Breakdown: entity buckets + event kinds as colored chips with counts. */}
            {(selectionSummary.entityBuckets.length > 0 || selectionSummary.eventKinds.length > 0) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                {selectionSummary.eventKinds.map((row) => (
                  <span
                    key={`sel-k-${row.key}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: colors.text2 }}
                    title={`${row.count} ${row.key} event${row.count === 1 ? '' : 's'}`}
                  >
                    <span style={{ width: 9, height: 9, borderRadius: '50%', border: `2px solid ${row.color}`, background: 'transparent', display: 'inline-block', boxSizing: 'border-box' }} />
                    {row.key} <span style={{ color: colors.dim }}>{row.count}</span>
                  </span>
                ))}
                {selectionSummary.entityBuckets.map((row) => (
                  <span
                    key={`sel-e-${row.key}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: colors.text2 }}
                    title={`${row.count} ${row.key} entit${row.count === 1 ? 'y' : 'ies'}`}
                  >
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: row.color, display: 'inline-block' }} />
                    {row.key} <span style={{ color: colors.dim }}>{row.count}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Top entities (by degree) — clickable chips that pivot+center. */}
            {selectionSummary.topEntities.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: colors.dim, marginBottom: 4 }}>Top entities</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {selectionSummary.topEntities.map((n) => (
                    <button
                      key={`sel-top-${n.id}`}
                      onClick={() => pivotTo(n)}
                      title={`${n.entityType || 'entity'} · deg ${degree.get(n.id) ?? 0}`}
                      style={chipBtnStyle(entityColor(n.entityType))}
                    >
                      <span style={{ color: entityColor(n.entityType) }}>{n.label || n.id}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Actions. */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => fgRef.current?.zoomToFit(500, 60, (node: any) => selectedIds.has(node.id))}
                style={{ flex: 1, padding: '6px 8px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text, cursor: 'pointer', fontSize: 12 }}
                title="Fit the selection to view"
              >
                ⤢ Center
              </button>
              <button
                onClick={exportSelectionCsv}
                style={{ flex: 1, padding: '6px 8px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text, cursor: 'pointer', fontSize: 12 }}
                title="Download the selection as CSV"
              >
                ⬇ CSV
              </button>
              <button
                onClick={clearSelection}
                style={{ flex: 1, padding: '6px 8px', borderRadius: 4, border: `1px solid ${colors.border}`, background: colors.panel, color: colors.text, cursor: 'pointer', fontSize: 12 }}
                title="Clear the selection"
              >
                ✕ Clear
              </button>
            </div>
          </div>
        )}

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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showClusters}
              onChange={(e) => setShowClusters(e.target.checked)}
            />
            <span>Show clusters<span style={{ color: colors.dim }}> (communities)</span></span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', opacity: clusterCount > 0 ? 1 : 0.5 }}>
            <input
              type="checkbox"
              checked={colorByCluster}
              disabled={clusterCount === 0}
              onChange={(e) => setColorByCluster(e.target.checked)}
            />
            <span>Color by cluster<span style={{ color: colors.dim }}> (vs type)</span></span>
          </label>
        </div>

        <div style={{ fontSize: 12, color: colors.dim, marginBottom: 12 }}>
          Nodes: {filteredNodes.length} | Links: {filteredLinks.length}
          {showClusters && clusterCount > 0 && (
            <span style={{ color: colors.dim }}> · {clusterCount} cluster{clusterCount === 1 ? '' : 's'}</span>
          )}
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
          {colorByCluster ? (
            clusterRows.length === 0 ? (
              <div style={{ fontSize: 11, color: colors.muted }}>no clusters in view</div>
            ) : (
              clusterRows.slice(0, 12).map((row) => (
                <div key={`c-${row.key}`} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }} title={row.key}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: row.color, display: 'inline-block' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.key}</span>
                  <span style={{ color: colors.dim }}>{row.count}</span>
                </div>
              ))
            )
          ) : (
            <>
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
            </>
          )}
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
            {/* Floating toolbar (Phase 2): zoom + quick-access toggles. Buttons
                wire to the SAME state setters as the canonical sidebar checkboxes,
                so they're a shortcut, not a second source of truth. */}
            <div style={toolbarStyle}>
              <button style={toolbarBtnStyle()} title="Zoom out" onClick={() => zoomBy(1 / 1.4)}>−</button>
              <button style={toolbarBtnStyle()} title="Fit graph to view" onClick={zoomFit}>⤢</button>
              <button style={toolbarBtnStyle()} title="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
              <span style={toolbarDividerStyle} />
              <button
                style={toolbarBtnStyle()}
                title="Search entities & events (⌘K)"
                onClick={() => setPaletteOpen(true)}
              >
                ⌘K
              </button>
              <button
                style={toolbarBtnStyle(showClusters)}
                title={showClusters ? 'Hide cluster hulls' : 'Show cluster hulls'}
                onClick={() => setShowClusters((v) => !v)}
              >
                ⬡ clusters
              </button>
              <button
                style={toolbarBtnStyle(colorByCluster, clusterCount === 0)}
                disabled={clusterCount === 0}
                title={
                  clusterCount === 0
                    ? 'No clusters in view'
                    : colorByCluster
                      ? 'Coloring by cluster — switch to type'
                      : 'Coloring by type — switch to cluster'
                }
                onClick={() => setColorByCluster((v) => !v)}
              >
                ● {colorByCluster ? 'cluster' : 'type'}
              </button>
              <span style={toolbarDividerStyle} />
              <button
                style={toolbarBtnStyle(lassoMode)}
                title={lassoMode ? 'Lasso select ON — drag a box to multi-select (click to exit)' : 'Lasso multi-select — drag a box over nodes'}
                onClick={() => {
                  setLassoMode((v) => !v);
                  setLassoRect(null);
                }}
              >
                ⬚ lasso
              </button>
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
                  // CLUSTER HULLS — translucent convex-hull regions per Louvain
                  // community, drawn BEHIND the nodes. Nodes keep type colors; the
                  // hull just shows "these belong together". Communities with < 3
                  // visible members are skipped so it doesn't clutter.
                  onRenderFramePre={(ctx: CanvasRenderingContext2D, gscale: number) => {
                    if (!showClusters || communities.size === 0) return;
                    const byComm = new Map<number, Array<{ x: number; y: number }>>();
                    for (const n of graphData.nodes as Array<{ id: string; x?: number; y?: number }>) {
                      if (n.x == null || n.y == null) continue;
                      const c = communities.get(n.id);
                      if (c == null) continue;
                      const arr = byComm.get(c);
                      if (arr) arr.push({ x: n.x, y: n.y });
                      else byComm.set(c, [{ x: n.x, y: n.y }]);
                    }
                    ctx.save();
                    for (const [c, pts] of byComm) {
                      if (pts.length < 3) continue;
                      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
                      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                      const hull = convexHull(pts);
                      if (hull.length < 3) continue;
                      const col = clusterColor(c);
                      const PAD = 16;
                      ctx.beginPath();
                      hull.forEach((p, i) => {
                        const dx = p.x - cx;
                        const dy = p.y - cy;
                        const len = Math.hypot(dx, dy) || 1;
                        const px = p.x + (dx / len) * PAD;
                        const py = p.y + (dy / len) * PAD;
                        if (i === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                      });
                      ctx.closePath();
                      ctx.fillStyle = `rgba(${rgb(col)}, 0.06)`;
                      ctx.fill();
                      ctx.strokeStyle = `rgba(${rgb(col)}, 0.28)`;
                      ctx.lineWidth = 1.2;
                      ctx.stroke();
                      // Region label = the community's top entity, above the hull.
                      const info = communityInfo.get(c);
                      if (info) {
                        const minY = Math.min(...pts.map((p) => p.y));
                        const fontSize = Math.max(3, 13 / gscale);
                        const text = info.label.length > 24 ? `${info.label.slice(0, 23)}…` : info.label;
                        ctx.font = `600 ${fontSize}px sans-serif`;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.lineJoin = 'round';
                        ctx.lineWidth = Math.max(1.2, 3 / gscale);
                        ctx.strokeStyle = `rgba(${rgb(colors.base)}, 0.9)`;
                        ctx.strokeText(text, cx, minY - PAD - fontSize * 0.4);
                        ctx.fillStyle = `rgba(${rgb(col)}, 0.92)`;
                        ctx.fillText(text, cx, minY - PAD - fontSize * 0.4);
                      }
                    }
                    ctx.restore();
                  }}
                  onNodeClick={(n: any) => setSelectedNode(n as GraphNode)}
                  onBackgroundClick={() => setSelectedNode(null)}
                  nodeCanvasObjectMode={() => 'replace'}
                  nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
                    const r = nodeRadius(n);
                    const isMatch = matchIds.has(n.id);
                    const isEntity = n.type === 'entity';
                    const isSelected = selectedIds.has(n.id);
                    // DIMMING precedence: an active lasso selection dims everything
                    // NOT selected (overrides single-node focus); otherwise fall back
                    // to focus-mode's 1-hop dimming.
                    const dimmed = selectedIds.size > 0 ? !isSelected : focusIds ? !focusIds.has(n.id) : false;
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

                    // LASSO-SELECTED nodes get a bold accent ring (drawn at full
                    // alpha so the selection pops against the dimmed remainder).
                    if (isSelected) {
                      ctx.globalAlpha = 1;
                      ctx.lineWidth = 2.5 / scale;
                      ctx.strokeStyle = colors.accent;
                      ctx.beginPath();
                      ctx.arc(n.x, n.y, r + 2.5 / scale, 0, 2 * Math.PI);
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

            {/* LASSO OVERLAY — absolutely positioned over the canvas only. Inert
                (pointerEvents:none) unless lassoMode is on, so panning/zooming and
                node clicks pass straight through to ForceGraph when disarmed. While
                armed, drag a box; the rectangle is drawn as a child div. */}
            <div
              ref={lassoLayerRef}
              onMouseDown={onLassoMouseDown}
              onMouseMove={onLassoMouseMove}
              onMouseUp={finishLassoDrag}
              onMouseLeave={finishLassoDrag}
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 4,
                cursor: 'crosshair',
                pointerEvents: lassoMode ? 'auto' : 'none',
              }}
            >
              {lassoRect && (
                <div
                  style={{
                    position: 'absolute',
                    left: Math.min(lassoRect.x0, lassoRect.x1),
                    top: Math.min(lassoRect.y0, lassoRect.y1),
                    width: Math.abs(lassoRect.x1 - lassoRect.x0),
                    height: Math.abs(lassoRect.y1 - lassoRect.y0),
                    border: `1px solid ${colors.teal}`,
                    background: `rgba(${rgb(colors.teal)}, 0.08)`,
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ----- ⌘K command palette (Phase 2 chrome) -----

interface PaletteAction {
  label: string;
  hint: string;
  run: () => void;
}

// Centered modal command palette built on headless cmdk. The backdrop dims the
// whole console and closes on click; the inner <Command> stops propagation so
// clicks inside don't dismiss it. cmdk owns keyboard nav (up/down/enter) and the
// fuzzy filter — we only feed it `value` strings and style its [cmdk-*] DOM via
// the scoped .wm-cmdk <style> block. Node Items match on "label id" so either
// hits. Selecting a node pivots+centers via the parent's pivotTo.
function CommandPalette({
  nodes,
  degree,
  actions,
  onClose,
  onRunAction,
  onSelectNode,
}: {
  nodes: GraphNode[];
  degree: Map<string, number>;
  actions: PaletteAction[];
  onClose: () => void;
  onRunAction: (run: () => void) => void;
  onSelectNode: (node: GraphNode) => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <style>{PALETTE_CSS}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '92vw',
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          overflow: 'hidden',
        }}
      >
        <Command className="wm-cmdk" label="Graph command palette">
          <Command.Input autoFocus placeholder="Search entities & events… (⌘K)" />
          <Command.List>
            <Command.Empty>No matches.</Command.Empty>

            <Command.Group heading="Actions">
              {actions.map((a) => (
                <Command.Item key={a.label} value={a.label} onSelect={() => onRunAction(a.run)}>
                  <span style={{ flex: 1 }}>{a.label}</span>
                  {a.hint && <span style={{ color: colors.dim, fontSize: 11 }}>{a.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Nodes">
              {nodes.map((n) => {
                const isEntity = n.type === 'entity';
                const chipColor = isEntity
                  ? entityColor(n.entityType)
                  : kindColors[n.kind || ''] || EVENT_RING_COLOR;
                const chipLabel = isEntity ? n.entityType || 'entity' : n.kind || 'event';
                const deg = degree.get(n.id) ?? 0;
                return (
                  <Command.Item
                    key={n.id}
                    value={`${n.label} ${n.id}`}
                    onSelect={() => onSelectNode(n)}
                  >
                    <span style={{ color: chipColor, fontSize: 11, width: 12, textAlign: 'center' }}>
                      {isEntity ? '▪' : '○'}
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {n.label}
                    </span>
                    <span style={{ color: chipColor, fontSize: 11 }}>{chipLabel}</span>
                    <span style={{ color: colors.dim, fontSize: 11 }}>deg {deg}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>
        </Command>
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
