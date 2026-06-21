import { useEffect, useState } from 'react';

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

const KIND_COLORS: Record<string, string> = {
  visual: '#22c55e',
  text: '#64748b',
  anomaly: '#ef4444',
  trend: '#3b82f6',
  alert: '#f59e0b',
  social_post: '#8b5cf6',
};

const ENTITY_COLORS: Record<string, string> = {
  ipv4: '#ef4444',
  ipv6: '#ef4444',
  domain: '#3b82f6',
  email: '#8b5cf6',
  hash_md5: '#10b981',
  hash_sha1: '#10b981',
  hash_sha256: '#10b981',
  cve: '#f59e0b',
  asn: '#06b6d4',
  btc_address: '#f97316',
};

export default function DashboardStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => r.json())
      .then((data) => setStats(data));
  }, []);

  if (!stats) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
        Loading dashboard...
      </div>
    );
  }

  const maxTimeline = Math.max(1, ...stats.events.timeline.map(([, c]) => c));
  const maxKind = Math.max(1, ...Object.values(stats.events.kindBreakdown));

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', background: '#f8fafc', minHeight: '100%' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, color: '#1e293b' }}>📊 Dashboard</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
          Uptime: {formatUptime(stats.uptime)} · Memory: {formatBytes(stats.memory.heapUsed)} / {formatBytes(stats.memory.heapTotal)}
        </p>
      </div>

      {/* Hero cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14, marginBottom: 28 }}>
        <HeroCard label="Sources" value={stats.sources.total} sub={`${stats.sources.enabled} enabled`} color="#111" />
        <HeroCard label="Events (1h)" value={stats.events.lastHour} sub={`${stats.events.lastDay} today`} color="#f59e0b" />
        <HeroCard label="Events (7d)" value={stats.events.lastWeek} sub="last week" color="#8b5cf6" />
        <HeroCard label="Entities" value={stats.entities.total} sub="extracted" color="#3b82f6" />
        <HeroCard label="Healthy" value={stats.sources.health.healthy} sub={`${stats.sources.health.warning} warn · ${stats.sources.health.critical} crit`} color="#22c55e" />
        <HeroCard label="Disabled" value={stats.sources.health.disabled} sub="sources" color="#94a3b8" />
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
                      background: count > 0 ? '#3b82f6' : '#e2e8f0',
                      borderRadius: '3px 3px 0 0',
                      minHeight: 4,
                      transition: 'height 0.3s',
                    }}
                    title={`${hour}: ${count} events`}
                  />
                  <span style={{ fontSize: 9, color: '#94a3b8', transform: 'rotate(-45deg)', transformOrigin: 'top left', whiteSpace: 'nowrap' }}>
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
            <HealthBar label="Healthy" count={stats.sources.health.healthy} total={stats.sources.total} color="#22c55e" />
            <HealthBar label="Warning" count={stats.sources.health.warning} total={stats.sources.total} color="#f59e0b" />
            <HealthBar label="Critical" count={stats.sources.health.critical} total={stats.sources.total} color="#ef4444" />
            <HealthBar label="Disabled" count={stats.sources.health.disabled} total={stats.sources.total} color="#94a3b8" />
          </div>
        </Section>

        {/* Events by Kind */}
        <Section title="📦 Events by Kind (24h)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
            {Object.entries(stats.events.kindBreakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 70, fontSize: 12, fontWeight: 600, color: '#475569', textTransform: 'capitalize' }}>{kind}</span>
                  <div style={{ flex: 1, height: 18, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${(count / maxKind) * 100}%`,
                        height: '100%',
                        background: KIND_COLORS[kind] || '#64748b',
                        borderRadius: 4,
                      }}
                    />
                  </div>
                  <span style={{ width: 40, fontSize: 12, color: '#64748b', textAlign: 'right' }}>{count}</span>
                </div>
              ))}
            {Object.keys(stats.events.kindBreakdown).length === 0 && (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: 12 }}>No events in the last 24 hours.</div>
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
                  style={{
                    padding: '6px 12px',
                    background: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 6,
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ fontWeight: 600, color: '#1e293b' }}>{count}</span>
                  <span style={{ color: '#64748b', textTransform: 'capitalize' }}>{kind.replace(/_/g, ' ')}</span>
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
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                  background: '#fff',
                  borderRadius: 6,
                  border: '1px solid #e2e8f0',
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: ENTITY_COLORS[e.type] || '#64748b',
                    color: '#fff',
                  }}
                >
                  {e.type}
                </span>
                <span style={{ flex: 1, fontSize: 12, color: '#1e293b', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.value}
                </span>
                <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>{e.count}</span>
              </div>
            ))}
            {stats.entities.top.length === 0 && (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: 12 }}>No entities extracted yet.</div>
            )}
          </div>
        </Section>

        {/* MITRE Techniques */}
        <Section title="🛡️ Top MITRE Techniques">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
            {stats.mitre.topTechniques.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                  background: '#fff',
                  borderRadius: 6,
                  border: '1px solid #e2e8f0',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: '#4338ca', fontFamily: 'monospace' }}>{t.id}</span>
                <span style={{ flex: 1, fontSize: 12, color: '#1e293b' }}>{t.name}</span>
                <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>{t.count}</span>
              </div>
            ))}
            {stats.mitre.topTechniques.length === 0 && (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: 12 }}>No MITRE techniques detected yet.</div>
            )}
          </div>
        </Section>

        {/* Top Sources */}
        <Section title="🔥 Top Sources (24h)">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px', color: '#64748b', fontWeight: 600 }}>Source</th>
                <th style={{ padding: '6px 8px', color: '#64748b', fontWeight: 600, textAlign: 'right' }}>Events</th>
              </tr>
            </thead>
            <tbody>
              {stats.events.topSources.map((s) => (
                <tr key={s.sourceId} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#334155' }}>{s.sourceId.slice(0, 24)}...</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600, color: '#1e293b' }}>{s.count}</td>
                </tr>
              ))}
              {stats.events.topSources.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ padding: 16, color: '#94a3b8', textAlign: 'center' }}>
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
    <div style={{ padding: 16, borderRadius: 10, background: '#fff', border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0', padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 13, color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
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
        <span style={{ color: '#475569', fontWeight: 500 }}>{label}</span>
        <span style={{ color: '#64748b' }}>
          {count} ({Math.round(pct)}%)
        </span>
      </div>
      <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
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
