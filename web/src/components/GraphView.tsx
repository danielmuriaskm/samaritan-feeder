import React, { useEffect, useState, useCallback, useMemo, Suspense, lazy, useRef } from 'react';
import { colors, kindColors, entityColors, rgb } from '../lib/theme.js';
import { getGraphNetwork, getLineage, graphExportUrl, type GraphOpts, type LineageNeighbor } from '../lib/api.js';

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

// Normalize the API's granular entityType keys (ipv4, hash_md5, btc_address, …)
// down to the canonical buckets in theme.ts `entityColors`. Pure presentation —
// no data/state is mutated.
function entityColor(entityType: string | undefined): string {
  const t = (entityType ?? '').toLowerCase();
  if (t.startsWith('ip')) return entityColors.ip;
  if (t.startsWith('hash')) return entityColors.hash;
  if (t === 'domain') return entityColors.domain;
  if (t === 'email') return entityColors.email;
  if (t === 'cve') return entityColors.cve;
  if (t === 'url') return entityColors.url;
  if (t === 'org' || t === 'asn') return entityColors.org;
  if (t === 'person') return entityColors.person;
  return entityColors[t] ?? entityColors.default;
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
  // 006 lineage drill-down for the selected EVENT node.
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
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

  // react-force-graph-2d MUTATES the links array in place, replacing each link's
  // `source`/`target` string id with the resolved node OBJECT after the first
  // render. A naive `nodeIds.has(l.source)` then fails on every subsequent render
  // (a Set of id strings never contains an object) and ALL links get dropped —
  // that's the "Links: 0 / no edges" bug. Extract the id from either shape.
  const linkEndId = (e: unknown): string =>
    e && typeof e === 'object' ? String((e as { id: unknown }).id) : String(e);

  const { filteredNodes, filteredLinks } = useMemo(() => {
    const nodes = data.nodes.filter((n) => {
      if (entityTypeFilter !== 'all' && n.type === 'entity' && n.entityType !== entityTypeFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q);
      }
      return true;
    });
    const ids = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => ids.has(linkEndId(l.source)) && ids.has(linkEndId(l.target)));
    return { filteredNodes: nodes, filteredLinks: links };
  }, [data, entityTypeFilter, searchQuery]);

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
      const s = typeof l.source === 'object' ? String((l.source as { id: unknown }).id) : String(l.source);
      const t = typeof l.target === 'object' ? String((l.target as { id: unknown }).id) : String(l.target);
      d.set(s, (d.get(s) ?? 0) + 1);
      d.set(t, (d.get(t) ?? 0) + 1);
    }
    return d;
  }, [filteredLinks]);

  const nodeFill = useCallback(
    (n: GraphNode): string => (n.type === 'entity' ? entityColor(n.entityType) : kindColors[n.kind || ''] || colors.dim),
    [],
  );
  const nodeRadius = useCallback(
    (n: GraphNode): number => (n.type === 'event' ? 3 : 2.5) + Math.min(6, Math.sqrt(degree.get(n.id) ?? 0)),
    [degree],
  );

  const hasData = !loading && filteredNodes.length > 0;
  const isEmpty = !loading && filteredNodes.length === 0 && !error;

  const selectedIsEvent = selectedNode?.type === 'event';
  const hasLineage = !!lineage && (lineage.parents.length > 0 || lineage.children.length > 0);

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

        <div style={{ fontSize: 12, color: colors.dim, marginBottom: 12 }}>
          Nodes: {filteredNodes.length} | Links: {filteredLinks.length}
        </div>

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

        <div>
          <h4 style={{ margin: '0 0 8px', fontSize: 12, color: colors.dim }}>Legend</h4>
          {Object.entries(kindColors).map(([kind, color]) => (
            <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {kind}
            </div>
          ))}
          {Object.entries(entityColors).map(([type, color]) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
              {type}
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
          <Suspense fallback={<GraphFallback />}>
            <ErrorBoundary fallback={<GraphError message="Graph rendering failed" />}>
              <ForceGraph2D
                ref={fgRef}
                graphData={graphData}
                nodeLabel="label"
                nodeVal={(n: any) => nodeRadius(n)}
                linkColor={() => `rgba(${rgb(colors.text)}, 0.18)`}
                linkWidth={(l: any) => (l.confidence ?? 0.5) * 1.5}
                backgroundColor={colors.base}
                onNodeClick={(n: any) => setSelectedNode(n as GraphNode)}
                nodeCanvasObjectMode={() => 'replace'}
                nodeCanvasObject={(n: any, ctx: CanvasRenderingContext2D, scale: number) => {
                  const r = nodeRadius(n);
                  ctx.beginPath();
                  ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
                  ctx.fillStyle = nodeFill(n);
                  ctx.fill();
                  if (selectedNode?.id === n.id) {
                    ctx.lineWidth = 2 / scale;
                    ctx.strokeStyle = '#fff';
                    ctx.stroke();
                  }
                  // Label when zoomed in, or always for hub nodes (degree >= 5).
                  const deg = degree.get(n.id) ?? 0;
                  if (n.label && (scale > 1.6 || deg >= 5)) {
                    const fontSize = Math.max(2.5, 11 / scale);
                    ctx.font = `${fontSize}px sans-serif`;
                    ctx.fillStyle = `rgba(${rgb(colors.text)}, 0.85)`;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
                    ctx.fillText(label, n.x + r + 1.5, n.y);
                  }
                }}
                nodePointerAreaPaint={(n: any, color: string, ctx: CanvasRenderingContext2D) => {
                  ctx.fillStyle = color;
                  ctx.beginPath();
                  ctx.arc(n.x, n.y, nodeRadius(n) + 2, 0, 2 * Math.PI);
                  ctx.fill();
                }}
                warmupTicks={20}
                cooldownTicks={80}
                onEngineStop={() => fgRef.current?.zoomToFit(400, 60)}
              />
            </ErrorBoundary>
          </Suspense>
        )}
      </div>
    </div>
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
  if (neighbors.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 11, color: colors.dim, marginBottom: 4 }}>
        {title} ({neighbors.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
      </div>
    </div>
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
