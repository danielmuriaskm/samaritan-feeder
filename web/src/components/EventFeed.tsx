import { useEffect, useState } from 'react';

interface IntelEvent {
  id: string;
  sourceId: string;
  kind: string;
  title?: string;
  content: string;
  confidence: number;
  eventAt: number;
  tags: Record<string, unknown>;
}

const kindColors: Record<string, string> = {
  visual: '#3b82f6',
  text: '#22c55e',
  anomaly: '#ef4444',
  alert: '#dc2626',
  social_post: '#8b5cf6',
};

export default function EventFeed() {
  const [events, setEvents] = useState<IntelEvent[]>([]);
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);

  useEffect(() => {
    const url = new URL('/api/events', window.location.origin);
    url.searchParams.set('limit', '50');
    if (query) url.searchParams.set('query', query);
    if (kinds.length) url.searchParams.set('kinds', kinds.join(','));

    fetch(url.toString())
      .then((r) => r.json())
      .then((data) => setEvents(data.events ?? []));
  }, [query, kinds]);

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <input
          type="text"
          placeholder="Search events..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc' }}
        />
        <select
          multiple
          value={kinds}
          onChange={(e) => setKinds(Array.from(e.target.selectedOptions).map((o) => o.value))}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', minWidth: 140 }}
        >
          {['visual', 'text', 'anomaly', 'alert', 'social_post'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {events.map((event) => (
          <div
            key={event.id}
            style={{
              padding: 16,
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
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
              <span style={{ fontSize: 12, color: '#666' }}>
                {new Date(event.eventAt).toLocaleString()}
              </span>
              <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
                {(event.confidence * 100).toFixed(0)}% confidence
              </span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{event.title ?? 'Untitled'}</div>
            <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.5 }}>{event.content}</div>
            {Object.keys(event.tags).length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(event.tags).map(([k, v]) => (
                  <span key={k} style={{ fontSize: 11, padding: '2px 8px', background: '#f3f4f6', borderRadius: 4 }}>
                    {k}: {String(v).slice(0, 30)}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
