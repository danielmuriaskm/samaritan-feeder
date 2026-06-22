import { useEffect, useMemo, useState } from 'react';
import { getSignals } from '../lib/api.js';
import type { IntelSignal, SignalKind } from '../lib/types.js';
import { signalColors, scoreColor } from '../lib/theme.js';

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
          className="wm-select"
          value={kinds}
          onChange={(e) =>
            setKinds(Array.from(e.target.selectedOptions).map((o) => o.value as SignalKind))
          }
          style={{ minWidth: 180 }}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {kindIcons[k]} {kindLabels[k]}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--wm-text)' }}>
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
            className="wm-btn"
            onClick={() => {
              setKinds([]);
              setMinScore(0);
            }}
            style={{ cursor: 'pointer' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Results count */}
      <div style={{ fontSize: 13, color: 'var(--wm-dim)', marginBottom: 12 }}>
        {loading
          ? 'Loading...'
          : `${totalShown.toLocaleString()} signal${totalShown === 1 ? '' : 's'} across ${groups.length} group${groups.length === 1 ? '' : 's'}`}
      </div>

      {/* Grouped signals */}
      {!loading && groups.length === 0 && (
        <div style={{ fontSize: 14, color: 'var(--wm-muted)', padding: '40px 0', textAlign: 'center' }}>
          No signals match the current filters.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {groups.map((group) => {
          const accent = signalColors[group.kind];
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
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: 'var(--wm-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  {kindLabels[group.kind]}
                </span>
                <span
                  className="wm-chip"
                  style={{ color: accent, borderColor: accent }}
                >
                  {group.items.length}
                </span>
              </div>

              {/* Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {group.items.map((sig) => (
                  <div
                    key={sig.id}
                    className="wm-card"
                    style={{
                      padding: 16,
                      borderLeft: `3px solid ${accent}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{sig.title}</span>
                      <span
                        className="wm-chip"
                        style={{
                          color: scoreColor(sig.score / 100),
                          borderColor: scoreColor(sig.score / 100),
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {sig.score.toFixed(0)}
                      </span>
                    </div>

                    {sig.summary && (
                      <div style={{ fontSize: 14, color: 'var(--wm-text-2)', lineHeight: 1.5, marginBottom: 8 }}>
                        {sig.summary}
                      </div>
                    )}

                    {/* Involved source chips */}
                    {sig.sourceIds && sig.sourceIds.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                        {sig.sourceIds.map((sid) => (
                          <span key={sid} className="wm-chip wm-meta">
                            📡 {sid}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Meta row */}
                    <div className="wm-meta" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--wm-dim)' }}>
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
