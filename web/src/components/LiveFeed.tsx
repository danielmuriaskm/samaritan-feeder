import { useState } from 'react';
import { useEventStream } from '../lib/useSSE.js';
import type { IntelEvent, IntelSignal } from '../lib/types.js';

const kindColors: Record<string, string> = {
  visual: '#3b82f6',
  text: '#22c55e',
  anomaly: '#ef4444',
  alert: '#dc2626',
  social_post: '#8b5cf6',
};

const signalKindColors: Record<string, string> = {
  convergence: '#0ea5e9',
  geo_convergence: '#14b8a6',
  velocity_spike: '#f59e0b',
  silent_source: '#6b7280',
  volume_anomaly: '#ec4899',
  cluster_surge: '#ef4444',
};

const signalKindIcons: Record<string, string> = {
  convergence: '🔀',
  geo_convergence: '🗺️',
  velocity_spike: '📈',
  silent_source: '🔇',
  volume_anomaly: '🌊',
  cluster_surge: '🚨',
};

// Score 0..1 (event.score) rendered as a 0-100 pill with a heat color.
function scoreColor(score: number): string {
  if (score >= 0.8) return '#dc2626';
  if (score >= 0.6) return '#ea580c';
  if (score >= 0.4) return '#d97706';
  if (score >= 0.2) return '#65a30d';
  return '#16a34a';
}

function ScorePill({ score }: { score: number }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 999,
        background: scoreColor(score),
        color: '#fff',
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
    <div
      style={{
        padding: 14,
        borderRadius: 8,
        border: '1px solid #e5e7eb',
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            padding: '2px 8px',
            borderRadius: 4,
            background: kindColors[event.kind] ?? '#999',
            color: '#fff',
          }}
        >
          {event.kind}
        </span>
        {event.score != null && <ScorePill score={event.score} />}
        <span style={{ fontSize: 12, color: '#6b7280' }}>{event.sourceId}</span>
        <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>{relativeTime(event.eventAt)}</span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{event.title ?? 'Untitled'}</div>
      <div
        style={{
          fontSize: 13,
          color: '#374151',
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
        <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
          📍 {event.location.lat.toFixed(4)}, {event.location.lon.toFixed(4)}
        </div>
      )}
    </div>
  );
}

function SignalRow({ signal }: { signal: IntelSignal }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        border: '1px solid #e5e7eb',
        borderLeft: `4px solid ${signalKindColors[signal.kind] ?? '#999'}`,
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14 }}>{signalKindIcons[signal.kind] ?? '📡'}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            padding: '2px 6px',
            borderRadius: 4,
            background: signalKindColors[signal.kind] ?? '#999',
            color: '#fff',
          }}
        >
          {signal.kind.replace('_', ' ')}
        </span>
        <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
          <ScorePill score={signal.score} />
        </span>
      </div>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{signal.title}</div>
      {signal.summary && (
        <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>{signal.summary}</div>
      )}
      <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>{relativeTime(signal.createdAt)}</div>
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
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: connected ? '#22c55e' : '#ef4444',
              boxShadow: connected ? '0 0 6px #22c55e' : 'none',
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: connected ? '#16a34a' : '#dc2626' }}>
            {connected ? 'Live' : 'Disconnected'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220 }}>
          <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
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
        <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
          {events.length} event{events.length === 1 ? '' : 's'} · {signals.length} signal
          {signals.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Two columns: live events + live signals */}
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {/* Events */}
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>⚡ Incoming events</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
            {events.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: 20, textAlign: 'center' }}>
                Waiting for live events…
              </div>
            ) : (
              events.map((ev) => <EventRow key={ev.id} event={ev} />)
            )}
          </div>
        </div>

        {/* Signals */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>🔔 Signals</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
            {signals.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: 20, textAlign: 'center' }}>
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
