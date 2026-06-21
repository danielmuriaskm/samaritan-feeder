import { useEffect, useMemo, useState } from 'react';
import { getSignals } from '../lib/api.js';
import type { IntelSignal, SignalKind } from '../lib/types.js';

// Cross-stream intelligence signals emitted by the MIT "brain" layer. Each kind
// gets a distinct accent color so an operator can scan groups at a glance.
const KIND_ORDER: SignalKind[] = [
  'convergence',
  'geo_convergence',
  'velocity_spike',
  'silent_source',
  'volume_anomaly',
  'cluster_surge',
];

const kindColors: Record<SignalKind, string> = {
  convergence: '#6366f1',
  geo_convergence: '#0ea5e9',
  velocity_spike: '#f59e0b',
  silent_source: '#64748b',
  volume_anomaly: '#ec4899',
  cluster_surge: '#ef4444',
};

const kindIcons: Record<SignalKind, string> = {
  convergence: '🔀',
  geo_convergence: '🗺️',
  velocity_spike: '⚡',
  silent_source: '🔇',
  volume_anomaly: '📈',
  cluster_surge: '🌊',
};

const kindLabels: Record<SignalKind, string> = {
  convergence: 'Convergence',
  geo_convergence: 'Geo convergence',
  velocity_spike: 'Velocity spike',
  silent_source: 'Silent source',
  volume_anomaly: 'Volume anomaly',
  cluster_surge: 'Cluster surge',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const REFRESH_MS = 20_000;

export default function SignalsPanel() {
  const [signals, setSignals] = useState<IntelSignal[]>([]);
  const [kinds, setKinds] = useState<SignalKind[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getSignals({ limit: 100 })
        .then((data) => {
          if (!alive) return;
          setSignals(data);
          setLoading(false);
        })
        .catch(() => {
          if (alive) setLoading(false);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Filter (kind multiselect + minScore), then bucket by kind, score-sorted desc.
  const groups = useMemo(() => {
    const filtered = signals.filter(
      (s) => s.score >= minScore && (kinds.length === 0 || kinds.includes(s.kind)),
    );
    return KIND_ORDER.map((kind) => ({
      kind,
      items: filtered
        .filter((s) => s.kind === kind)
        .sort((a, b) => b.score - a.score),
    })).filter((g) => g.items.length > 0);
  }, [signals, kinds, minScore]);

  const totalShown = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          multiple
          value={kinds}
          onChange={(e) =>
            setKinds(Array.from(e.target.selectedOptions).map((o) => o.value as SignalKind))
          }
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', minWidth: 180, fontSize: 14 }}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {kindIcons[k]} {kindLabels[k]}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' }}>
          <span style={{ whiteSpace: 'nowrap' }}>Min score</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            style={{ width: 160 }}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28, fontWeight: 600 }}>
            {minScore}
          </span>
        </label>
        {(kinds.length > 0 || minScore > 0) && (
          <button
            onClick={() => {
              setKinds([]);
              setMinScore(0);
            }}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid #ccc',
              background: '#f3f4f6',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Results count */}
      <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
        {loading
          ? 'Loading...'
          : `${totalShown.toLocaleString()} signal${totalShown === 1 ? '' : 's'} across ${groups.length} group${groups.length === 1 ? '' : 's'}`}
      </div>

      {/* Grouped signals */}
      {!loading && groups.length === 0 && (
        <div style={{ fontSize: 14, color: '#9ca3af', padding: '40px 0', textAlign: 'center' }}>
          No signals match the current filters.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {groups.map((group) => {
          const accent = kindColors[group.kind];
          return (
            <div key={group.kind}>
              {/* Group header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                  paddingBottom: 6,
                  borderBottom: `2px solid ${accent}`,
                }}
              >
                <span style={{ fontSize: 16 }}>{kindIcons[group.kind]}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: accent }}>
                  {kindLabels[group.kind]}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#fff',
                    background: accent,
                    borderRadius: 10,
                    padding: '1px 8px',
                  }}
                >
                  {group.items.length}
                </span>
              </div>

              {/* Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {group.items.map((sig) => (
                  <div
                    key={sig.id}
                    style={{
                      padding: 16,
                      borderRadius: 8,
                      border: '1px solid #e5e7eb',
                      borderLeft: `4px solid ${accent}`,
                      background: '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{sig.title}</span>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: '#fff',
                          background: accent,
                          borderRadius: 12,
                          padding: '2px 10px',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {sig.score.toFixed(0)}
                      </span>
                    </div>

                    {sig.summary && (
                      <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.5, marginBottom: 8 }}>
                        {sig.summary}
                      </div>
                    )}

                    {/* Involved source chips */}
                    {sig.sourceIds && sig.sourceIds.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {sig.sourceIds.map((sid) => (
                          <span
                            key={sid}
                            style={{
                              fontSize: 11,
                              padding: '2px 8px',
                              background: '#f3f4f6',
                              borderRadius: 4,
                              color: '#4b5563',
                            }}
                          >
                            📡 {sid}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Meta row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: '#6b7280' }}>
                      <span>
                        {(sig.eventIds?.length ?? 0).toLocaleString()} event
                        {(sig.eventIds?.length ?? 0) === 1 ? '' : 's'}
                      </span>
                      {sig.location && (
                        <span>
                          📍 {sig.location.lat.toFixed(4)}, {sig.location.lon.toFixed(4)}
                        </span>
                      )}
                      {sig.clusterId && <span>🧩 {sig.clusterId}</span>}
                      <span style={{ marginLeft: 'auto' }}>{relativeTime(sig.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
