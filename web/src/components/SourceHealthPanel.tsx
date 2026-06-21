import { useEffect, useMemo, useState } from 'react';
import { getSources } from '../lib/api.js';
import type { Source, SourceHealthState } from '../lib/types.js';

// Source-kind emoji icons (mirrors EventFeed.tsx / SourcePanel.tsx idiom).
const sourceKindIcons: Record<string, string> = {
  rss: '📰', reddit: '🤖', hn: '🧠', bluesky: '🦋', twitter: '🐦', instagram: '📸',
  tiktok: '🎵', youtube: '📺', telegram: '✈️', discord: '🎮', webcam: '📹',
  traffic_cam: '🚗', weather_cam: '🌤️', ip_camera: '📡', news_api: '🗞️',
  gdelt: '🌍', github: '💻', arxiv: '📄', windy: '🌬️',
  shodan: '🌐', censys: '🔍', crtsh: '📜', virustotal: '🛡️', hibp: '💀',
  webcrawl: '🕷️', twitter_scrape: '🐦', reddit_scrape: '🤖', sherlock: '🔎',
};

// healthState -> chip color. silent/failing/cooldown are the feeds we want to surface.
const STATE_COLORS: Record<SourceHealthState, string> = {
  healthy: '#22c55e',
  degraded: '#f59e0b',
  silent: '#f97316',
  failing: '#ef4444',
  cooldown: '#dc2626',
};

const STATE_LABELS: Record<SourceHealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  silent: 'Silent',
  failing: 'Failing',
  cooldown: 'Cooldown',
};

// States that warrant being sorted to the top + visually flagged.
const ALERT_STATES = new Set<SourceHealthState>(['silent', 'failing', 'cooldown']);

// Lower number = higher up in the table. Worst first.
const STATE_RANK: Record<SourceHealthState, number> = {
  failing: 0,
  cooldown: 1,
  silent: 2,
  degraded: 3,
  healthy: 4,
};

const STATE_ORDER: SourceHealthState[] = ['failing', 'cooldown', 'silent', 'degraded', 'healthy'];

// Derive a state when the server hasn't computed one (defensive; keeps the panel useful).
function deriveState(s: Source): SourceHealthState {
  if (s.healthState) return s.healthState;
  if (s.cooldownUntil && s.cooldownUntil > Date.now()) return 'cooldown';
  if ((s.consecutiveFailures ?? 0) >= 3) return 'failing';
  if (s.errorCount > 0) return 'degraded';
  return 'healthy';
}

function relativeAge(from: number | undefined, now: number): string {
  if (!from) return 'never';
  const ms = now - from;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

function countdown(until: number | undefined, now: number): string | null {
  if (!until) return null;
  const ms = until - now;
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function StateChip({ state }: { state: SourceHealthState }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: 4,
        background: STATE_COLORS[state],
        color: '#fff',
        whiteSpace: 'nowrap',
      }}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

function MetaItem({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <span style={{ fontSize: 12, color: danger ? '#dc2626' : '#6b7280', whiteSpace: 'nowrap' }}>
      <span style={{ color: danger ? '#dc2626' : '#9ca3af' }}>{label}: </span>
      <span style={{ fontWeight: danger ? 600 : 400 }}>{value}</span>
    </span>
  );
}

export default function SourceHealthPanel() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Drives relative ages + cooldown countdowns; ticks every second.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getSources()
        .then((data) => {
          if (cancelled) return;
          setSources(data);
          setError('');
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setError('Failed to load sources');
          setLoading(false);
        });
    };
    load();
    const refresh = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Only enabled sources are meaningfully "polled"; disabled ones can't go silent.
  const tracked = useMemo(() => sources.filter((s) => s.enabled), [sources]);

  // Worst-first sort: alert states bubble to the top (the whole point).
  const sorted = useMemo(() => {
    return [...tracked].sort((a, b) => {
      const ra = STATE_RANK[deriveState(a)];
      const rb = STATE_RANK[deriveState(b)];
      if (ra !== rb) return ra - rb;
      // Within a state, surface the most-stale (oldest last event) first.
      return (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0);
    });
  }, [tracked, now]);

  const counts = useMemo(() => {
    const c: Record<SourceHealthState, number> = {
      healthy: 0, degraded: 0, silent: 0, failing: 0, cooldown: 0,
    };
    for (const s of tracked) c[deriveState(s)] += 1;
    return c;
  }, [tracked, now]);

  const alertCount = counts.silent + counts.failing + counts.cooldown;

  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto', height: '100%', overflowY: 'auto', width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🩺 Source Health</h2>
        <span style={{ fontSize: 13, color: '#6b7280' }}>
          {loading ? 'Loading...' : `${tracked.length} active feed${tracked.length === 1 ? '' : 's'} · refreshes every 30s`}
        </span>
        {alertCount > 0 && (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginLeft: 'auto' }}>
            ⚠️ {alertCount} feed{alertCount === 1 ? '' : 's'} need attention
          </span>
        )}
      </div>

      {/* Summary strip: counts per state */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {STATE_ORDER.map((state) => (
          <div
            key={state}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              background: counts[state] > 0 && ALERT_STATES.has(state) ? '#fef2f2' : '#fff',
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: STATE_COLORS[state] }} />
            <span style={{ fontSize: 20, fontWeight: 700, color: counts[state] > 0 ? '#111' : '#9ca3af' }}>
              {counts[state]}
            </span>
            <span style={{ fontSize: 12, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {STATE_LABELS[state]}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ padding: '10px 12px', borderRadius: 6, background: '#fef2f2', color: '#dc2626', fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {!loading && tracked.length === 0 && !error && (
        <div style={{ color: '#6b7280', padding: 40, textAlign: 'center' }}>No active sources to monitor.</div>
      )}

      {/* Source cards (sorted worst-first) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((source) => {
          const state = deriveState(source);
          const isAlert = ALERT_STATES.has(state);
          const cd = state === 'cooldown' ? countdown(source.cooldownUntil, now) : null;
          const failures = source.consecutiveFailures ?? 0;
          return (
            <div
              key={source.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '12px 16px',
                borderRadius: 8,
                border: isAlert ? `1px solid ${STATE_COLORS[state]}` : '1px solid #e5e7eb',
                background: isAlert ? '#fff7f5' : '#fff',
                borderLeft: `4px solid ${STATE_COLORS[state]}`,
              }}
            >
              <div style={{ fontSize: 22, lineHeight: 1, paddingTop: 2 }}>
                {sourceKindIcons[source.kind] ?? '📡'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  {isAlert && <span title="Needs attention">🚨</span>}
                  <span style={{ fontWeight: 600, fontSize: 14, color: '#1e293b' }}>{source.name}</span>
                  <StateChip state={state} />
                  <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'capitalize' }}>
                    {source.kind.replace(/_/g, ' ')}
                  </span>
                  {cd && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: '#fee2e2',
                        color: '#dc2626',
                        marginLeft: 'auto',
                      }}
                    >
                      ⏳ cooldown {cd}
                    </span>
                  )}
                </div>
                {/* Meta row */}
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                  <MetaItem
                    label="last event"
                    value={relativeAge(source.lastEventAt, now)}
                    danger={isAlert && state !== 'failing'}
                  />
                  <MetaItem label="last poll" value={relativeAge(source.lastPolledAt, now)} />
                  <MetaItem label="interval" value={`${source.pollIntervalSeconds}s`} />
                  {failures > 0 && (
                    <MetaItem label="consec. fails" value={String(failures)} danger />
                  )}
                  {source.errorCount > 0 && (
                    <MetaItem label="errors" value={String(source.errorCount)} danger />
                  )}
                  {source.lastLatencyMs !== undefined && (
                    <MetaItem label="latency" value={`${source.lastLatencyMs}ms`} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
