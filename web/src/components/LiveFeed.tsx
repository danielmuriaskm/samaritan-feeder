import { useState } from 'react';
import { useEventStream } from '../lib/useSSE.js';
import type { IntelEvent, IntelSignal } from '../lib/types.js';
import { colors, kindColors, signalColors, scoreColor } from '../lib/theme.js';

const signalKindIcons: Record<string, string> = {
  convergence: '🔀',
  geo_convergence: '🗺️',
  velocity_spike: '📈',
  silent_source: '🔇',
  volume_anomaly: '🌊',
  cluster_surge: '🚨',
};

function ScorePill({ score }: { score: number }) {
  return (
    <span
      className="wm-chip"
      style={{
        fontSize: 11,
        fontWeight: 700,
        background: scoreColor(score),
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {(score * 100).toFixed(0)}
    </span>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function EventRow({ event }: { event: IntelEvent }) {
  return (
    <div className="wm-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span
          className="wm-chip"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            background: kindColors[event.kind] ?? colors.dim,
          }}
        >
          {event.kind}
        </span>
        {event.score != null && <ScorePill score={event.score} />}
        <span className="wm-meta" style={{ fontSize: 12 }}>{event.sourceId}</span>
        <span className="wm-meta" style={{ fontSize: 12, marginLeft: 'auto' }}>{relativeTime(event.eventAt)}</span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{event.title ?? 'Untitled'}</div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--wm-text-2)',
          lineHeight: 1.5,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {event.content}
      </div>
      {event.location && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--wm-dim)' }}>
          📍 {event.location.lat.toFixed(4)}, {event.location.lon.toFixed(4)}
        </div>
      )}
    </div>
  );
}

function SignalRow({ signal }: { signal: IntelSignal }) {
  return (
    <div
      className="wm-card"
      style={{
        padding: 12,
        borderLeft: `4px solid ${signalColors[signal.kind] ?? colors.dim}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14 }}>{signalKindIcons[signal.kind] ?? '📡'}</span>
        <span
          className="wm-chip"
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            background: signalColors[signal.kind] ?? colors.dim,
          }}
        >
          {signal.kind.replace('_', ' ')}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <ScorePill score={signal.score} />
        </span>
      </div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{signal.title}</div>
      {signal.summary && (
        <div style={{ fontSize: 12, color: 'var(--wm-dim)', lineHeight: 1.4 }}>{signal.summary}</div>
      )}
      <div className="wm-meta" style={{ marginTop: 4, fontSize: 11 }}>{relativeTime(signal.createdAt)}</div>
    </div>
  );
}

export default function LiveFeed() {
  const [minScore, setMinScore] = useState(0);
  const { events, signals, connected } = useEventStream('operator', { minScore: minScore || undefined, max: 200 });

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header: connection + filter */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className={connected ? 'wm-dot wm-dot--glow wm-live-dot' : 'wm-dot'}
            style={{
              background: connected ? colors.live : colors.critical,
              color: connected ? colors.live : colors.critical,
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: connected ? 'var(--wm-live)' : 'var(--wm-critical)' }}>
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220 }}>
          <span className="wm-meta" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            min score {(minScore * 100).toFixed(0)}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            style={{ flex: 1, maxWidth: 260, cursor: 'pointer' }}
          />
        </div>
        <span className="wm-meta" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {events.length} event{events.length === 1 ? '' : 's'} · {signals.length} signal
          {signals.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Two columns: live events + live signals */}
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {/* Events */}
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--wm-text)', marginBottom: 8 }}>⚡ Incoming events</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
            {events.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--wm-muted)', padding: 20, textAlign: 'center' }}>
                Waiting for live events…
              </div>
            ) : (
              events.map((ev) => <EventRow key={ev.id} event={ev} />)
            )}
          </div>
        </div>

        {/* Signals */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--wm-text)', marginBottom: 8 }}>🔔 Signals</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
            {signals.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--wm-muted)', padding: 20, textAlign: 'center' }}>
                No signals yet…
              </div>
            ) : (
              signals.map((sig) => <SignalRow key={sig.id} signal={sig} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
