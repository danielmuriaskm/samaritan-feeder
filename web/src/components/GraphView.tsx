import React, { useEffect, useState, useCallback, Suspense, lazy, useRef } from 'react';
import { colors, kindColors, entityColors, rgb } from '../lib/theme.js';

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

export default function GraphView() {
  const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('all');
  const fgRef = useRef<any>(null);

  useEffect(() => {
    loadNetwork();
  }, []);

  const loadNetwork = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/graph/network?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as GraphData;
      setData(json);
    } catch (err) {
      console.error('Failed to load graph:', err);
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredNodes = data.nodes.filter((n) => {
    if (entityTypeFilter !== 'all' && n.type === 'entity' && n.entityType !== entityTypeFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q);
    }
    return true;
  });

  const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredLinks = data.links.filter((l) => filteredNodeIds.has(l.source) && filteredNodeIds.has(l.target));

  const entityTypes = [...new Set(data.nodes.filter((n) => n.type === 'entity').map((n) => n.entityType).filter(Boolean))];

  const hasData = !loading && filteredNodes.length > 0;
  const isEmpty = !loading && filteredNodes.length === 0 && !error;

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
                graphData={{ nodes: filteredNodes, links: filteredLinks }}
                nodeAutoColorBy="type"
                nodeLabel="label"
                nodeColor={(n: any) => {
                  if (n.type === 'entity') return entityColor(n.entityType);
                  return kindColors[n.kind || ''] || colors.dim;
                }}
                nodeVal={(n: any) => (n.type === 'event' ? 6 : 4)}
                linkColor={() => `rgba(${rgb(colors.text)}, 0.2)`}
                linkWidth={(l: any) => (l.confidence ?? 0.5) * 2}
                backgroundColor={colors.base}
                onNodeClick={(n: any) => setSelectedNode(n as GraphNode)}
                warmupTicks={10}
                cooldownTicks={50}
                width={undefined}
                height={undefined}
              />
            </ErrorBoundary>
          </Suspense>
        )}
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


