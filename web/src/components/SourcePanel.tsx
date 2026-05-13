import { useEffect, useState } from 'react';

interface Source {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  lastPolledAt?: number;
  lastEventAt?: number;
  errorCount: number;
}

export default function SourcePanel() {
  const [sources, setSources] = useState<Source[]>([]);
  const [library, setLibrary] = useState<Array<{ key: string; name: string; count: number }>>([]);

  useEffect(() => {
    fetch('/api/sources')
      .then((r) => r.json())
      .then((data) => setSources(data.sources ?? []));
    fetch('/api/library')
      .then((r) => r.json())
      .then((data) => setLibrary(data.categories ?? []));
  }, []);

  const toggleSource = async (id: string, enabled: boolean) => {
    await fetch(`/api/sources/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
  };

  const importCategory = async (categoryKey: string) => {
    const res = await fetch(`/api/library/webcams?category=${categoryKey}`);
    const data = await res.json();
    const names = (data.webcams ?? []).map((w: { name: string }) => w.name);
    await fetch('/api/library/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    });
    // Refresh sources
    const s = await fetch('/api/sources').then((r) => r.json());
    setSources(s.sources ?? []);
  };

  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}>
      <h2>Active Sources</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 32 }}>
        {sources.map((source) => (
          <div
            key={source.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '12px 16px',
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              background: source.enabled ? '#fff' : '#f9fafb',
              opacity: source.enabled ? 1 : 0.6,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{source.name}</div>
              <div style={{ fontSize: 12, color: '#666' }}>
                {source.kind} · Last polled: {source.lastPolledAt ? new Date(source.lastPolledAt).toLocaleString() : 'Never'}
                {source.errorCount > 0 && <span style={{ color: '#ef4444', marginLeft: 8 }}>⚠️ {source.errorCount} errors</span>}
              </div>
            </div>
            <button
              onClick={() => toggleSource(source.id, source.enabled)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                background: source.enabled ? '#22c55e' : '#6b7280',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              {source.enabled ? 'On' : 'Off'}
            </button>
          </div>
        ))}
      </div>

      <h2>Webcam Library</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {library.map((cat) => (
          <div key={cat.key} style={{ padding: 16, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{cat.name}</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>{cat.count} cameras</div>
            <button
              onClick={() => importCategory(cat.key)}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 6,
                border: 'none',
                background: '#111',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Import All
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
