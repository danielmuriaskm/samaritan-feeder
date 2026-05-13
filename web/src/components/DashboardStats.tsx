import { useEffect, useState } from 'react';

interface Stats {
  sources: {
    total: number;
    enabled: number;
    healthy: number;
    byKind: Record<string, number>;
  };
  events: {
    lastHour: number;
    lastDay: number;
    kindBreakdown: Record<string, number>;
    topSources: Array<{ sourceId: string; count: number }>;
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

  if (!stats) return <div style={{ padding: 40 }}>Loading...</div>;

  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, marginBottom: 32 }}>
        <StatCard label="Total Sources" value={stats.sources.total} />
        <StatCard label="Enabled" value={stats.sources.enabled} color="#22c55e" />
        <StatCard label="Healthy" value={stats.sources.healthy} color="#3b82f6" />
        <StatCard label="Events (1h)" value={stats.events.lastHour} color="#f59e0b" />
        <StatCard label="Events (24h)" value={stats.events.lastDay} color="#8b5cf6" />
        <StatCard
          label="Uptime"
          value={`${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`}
          color="#666"
        />
      </div>

      <h3>Events by Kind</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 32 }}>
        {Object.entries(stats.events.kindBreakdown).map(([kind, count]) => (
          <div key={kind} style={{ padding: '8px 16px', background: '#f3f4f6', borderRadius: 6 }}>
            <span style={{ fontWeight: 600 }}>{kind}</span>: {count}
          </div>
        ))}
      </div>

      <h3>Top Sources (24h)</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px' }}>Source ID</th>
            <th style={{ padding: '8px 12px' }}>Events</th>
          </tr>
        </thead>
        <tbody>
          {stats.events.topSources.map((s) => (
            <tr key={s.sourceId} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12 }}>{s.sourceId}</td>
              <td style={{ padding: '8px 12px' }}>{s.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value, color = '#111' }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ padding: 20, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
