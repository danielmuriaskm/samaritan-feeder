import { useEffect, useState } from 'react';
import { colors, kindColors, entityColors, healthColors } from '../lib/theme.js';

interface Stats {
  sources: {
    total: number;
    enabled: number;
    healthy: number;
    byKind: Record<string, number>;
    health: { healthy: number; warning: number; critical: number; disabled: number };
  };
  events: {
    lastHour: number;
    lastDay: number;
    lastWeek: number;
    kindBreakdown: Record<string, number>;
    topSources: Array<{ sourceId: string; count: number }>;
    timeline: Array<[string, number]>;
  };
  entities: {
    total: number;
    byType: Array<{ type: string; count: number }>;
    top: Array<{ id: string; type: string; value: string; count: number }>;
  };
  mitre: {
    topTechniques: Array<{ id: string; name: string; count: number }>;
  };
  uptime: number;
  memory: { heapUsed: number; heapTotal: number; rss: number };
}

export default function DashboardStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => r.json())
      .then((data) => setStats(data));
  }, []);

  if (!stats) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: colors.dim }}>
        Loading dashboard...
      </div>
    );
  }

  const maxTimeline = Math.max(1, ...stats.events.timeline.map(([, c]) => c));
  const maxKind = Math.max(1, ...Object.values(stats.events.kindBreakdown));

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', minHeight: '100%' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, color: colors.text }}>📊 Dashboard</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: colors.dim }}>
          Uptime: {formatUptime(stats.uptime)} · Memory: {formatBytes(stats.memory.heapUsed)} / {formatBytes(stats.memory.heapTotal)}
        </p>
      </div>

      {/* Hero cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14, marginBottom: 28 }}>
        <HeroCard label="Sources" value={stats.sources.total} sub={`${stats.sources.enabled} enabled`} color={colors.text} />
        <HeroCard label="Events (1h)" value={stats.events.lastHour} sub={`${stats.events.lastDay} today`} color={colors.elevated} />
        <HeroCard label="Events (7d)" value={stats.events.lastWeek} sub="last week" color={colors.purple} />
        <HeroCard label="Entities" value={stats.entities.total} sub="extracted" color={colors.low} />
        <HeroCard label="Healthy" value={stats.sources.health.healthy} sub={`${stats.sources.health.warning} warn · ${stats.sources.health.critical} crit`} color={colors.normal} />
        <HeroCard label="Disabled" value={stats.sources.health.disabled} sub="sources" color={colors.muted} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        {/* Timeline */}
        <Section title="📈 Events Timeline (24h)">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, padding: '8px 0' }}>
            {stats.events.timeline.map(([hour, count]) => {
              const pct = (count / maxTimeline) * 100;
              return (
                <div key={hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div
                    style={{
                      width: '100%',
                      height: `${Math.max(pct, 4)}%`,
                      background: count > 0 ? colors.info : 'var(--wm-hover)',
                      borderRadius: '3px 3px 0 0',
                      minHeight: 4,
                      transition: 'height 0.3s',
                    }}
                    title={`${hour}: ${count} events`}
                  />
                  <span style={{ fontSize: 9, color: colors.muted, fontFamily: 'var(--wm-font-mono)', transform: 'rotate(-45deg)', transformOrigin: 'top left', whiteSpace: 'nowrap' }}>
                    {hour}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Source Health */}
        <Section title="🩺 Source Health">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
            <HealthBar label="Healthy" count={stats.sources.health.healthy} total={stats.sources.total} color={healthColors.healthy} />
            <HealthBar label="Warning" count={stats.sources.health.warning} total={stats.sources.total} color={healthColors.degraded} />
            <HealthBar label="Critical" count={stats.sources.health.critical} total={stats.sources.total} color={healthColors.failing} />
            <HealthBar label="Disabled" count={stats.sources.health.disabled} total={stats.sources.total} color={colors.muted} />
          </div>
        </Section>

        {/* Events by Kind */}
        <Section title="📦 Events by Kind (24h)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
            {Object.entries(stats.events.kindBreakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 70, fontSize: 12, fontWeight: 600, color: colors.text2, textTransform: 'capitalize' }}>{kind}</span>
                  <div style={{ flex: 1, height: 18, background: 'var(--wm-hover)', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${(count / maxKind) * 100}%`,
                        height: '100%',
                        background: kindColors[kind] || colors.muted,
                        borderRadius: 4,
                      }}
                    />
                  </div>
                  <span style={{ width: 40, fontSize: 12, color: colors.dim, textAlign: 'right', fontFamily: 'var(--wm-font-mono)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                </div>
              ))}
            {Object.keys(stats.events.kindBreakdown).length === 0 && (
              <div style={{ fontSize: 13, color: colors.muted, padding: 12 }}>No events in the last 24 hours.</div>
            )}
          </div>
        </Section>

        {/* Sources by Kind */}
        <Section title="📡 Sources by Kind">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 0' }}>
            {Object.entries(stats.sources.byKind)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <div
                  key={kind}
                  className="wm-card"
                  style={{
                    padding: '6px 12px',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ fontWeight: 600, color: colors.text, fontFamily: 'var(--wm-font-mono)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                  <span style={{ color: colors.dim, textTransform: 'capitalize' }}>{kind.replace(/_/g, ' ')}</span>
                </div>
              ))}
          </div>
        </Section>

        {/* Top Entities */}
        <Section title="🔖 Top Entities">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
            {stats.entities.top.map((e) => (
              <div
                key={e.id}
                className="wm-card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                }}
              >
                <span
                  className="wm-chip"
                  style={{
                    fontSize: 10,
                    background: entityColors[e.type] || entityColors.default,
                  }}
                >
                  {e.type}
                </span>
                <span style={{ flex: 1, fontSize: 12, color: colors.text, fontFamily: 'var(--wm-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.value}
                </span>
                <span style={{ fontSize: 11, color: colors.dim, fontWeight: 600, fontFamily: 'var(--wm-font-mono)', fontVariantNumeric: 'tabular-nums' }}>{e.count}</span>
              </div>
            ))}
            {stats.entities.top.length === 0 && (
              <div style={{ fontSize: 13, color: colors.muted, padding: 12 }}>No entities extracted yet.</div>
            )}
          </div>
        </Section>

        {/* MITRE Techniques */}
        <Section title="🛡️ Top MITRE Techniques">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
            {stats.mitre.topTechniques.map((t) => (
              <div
                key={t.id}
                className="wm-card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: colors.purple, fontFamily: 'var(--wm-font-mono)' }}>{t.id}</span>
                <span style={{ flex: 1, fontSize: 12, color: colors.text }}>{t.name}</span>
                <span style={{ fontSize: 11, color: colors.dim, fontWeight: 600, fontFamily: 'var(--wm-font-mono)', fontVariantNumeric: 'tabular-nums' }}>{t.count}</span>
              </div>
            ))}
            {stats.mitre.topTechniques.length === 0 && (
              <div style={{ fontSize: 13, color: colors.muted, padding: 12 }}>No MITRE techniques detected yet.</div>
            )}
          </div>
        </Section>

        {/* Top Sources */}
        <Section title="🔥 Top Sources (24h)">
          <table className="wm-table">
            <thead>
              <tr>
                <th>Source</th>
                <th style={{ textAlign: 'right' }}>Events</th>
              </tr>
            </thead>
            <tbody>
              {stats.events.topSources.map((s) => (
                <tr key={s.sourceId}>
                  <td style={{ fontFamily: 'var(--wm-font-mono)' }}>{s.sourceId.slice(0, 24)}...</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: colors.text }}>{s.count}</td>
                </tr>
              ))}
              {stats.events.topSources.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ padding: 16, color: colors.muted, textAlign: 'center' }}>
                    No events in the last 24 hours.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}

function HeroCard({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  return (
    <div className="wm-card" style={{ padding: 16 }}>
      <div style={{ fontSize: 11, color: colors.dim, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color, lineHeight: 1, fontFamily: 'var(--wm-font-mono)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="wm-card" style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 13, color: colors.text2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function HealthBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: colors.text2, fontWeight: 500 }}>{label}</span>
        <span style={{ color: colors.dim, fontFamily: 'var(--wm-font-mono)', fontVariantNumeric: 'tabular-nums' }}>
          {count} ({Math.round(pct)}%)
        </span>
      </div>
      <div style={{ height: 8, background: 'var(--wm-hover)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${Math.round(size)} ${units[i]}`;
}
