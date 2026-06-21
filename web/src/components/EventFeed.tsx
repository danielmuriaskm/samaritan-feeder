import { useEffect, useState, type ReactNode } from 'react';
import { getEvents, getSources } from '../lib/api.js';
import type { IntelEvent, Source } from '../lib/types.js';

const kindColors: Record<string, string> = {
  visual: '#3b82f6',
  text: '#22c55e',
  anomaly: '#ef4444',
  alert: '#dc2626',
  social_post: '#8b5cf6',
  detection: '#f59e0b',
};

const sourceKindIcons: Record<string, string> = {
  reddit: '🤖',
  rss: '📰',
  hn: '🧠',
  bluesky: '🦋',
  twitter: '🐦',
  instagram: '📸',
  tiktok: '🎵',
  youtube: '📺',
  telegram: '✈️',
  discord: '🎮',
  webcam: '📹',
  traffic_cam: '🚗',
  weather_cam: '🌤️',
  ip_camera: '📹',
  news_api: '📰',
  gdelt: '🌍',
  github: '💻',
  arxiv: '📄',
  windy: '🌬️',
  usgs: '🌐',
  eonet: '🛰️',
  gdacs: '🚨',
  nws: '🌪️',
  abusech: '☣️',
  ngamsi: '⚓',
  reliefweb: '🆘',
};

// Color-grade a 0..1 score from green (low) -> amber -> red (high importance).
function scoreColor(score: number): string {
  if (score >= 0.75) return '#dc2626';
  if (score >= 0.5) return '#f59e0b';
  if (score >= 0.25) return '#eab308';
  return '#22c55e';
}

const URL_RE =
  /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/g;

function LinkifyText({ text }: { text: string }) {
  const parts: (string | ReactNode)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(URL_RE.source, URL_RE.flags);

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#2563eb', textDecoration: 'underline', wordBreak: 'break-all' }}
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

export default function EventFeed() {
  const [events, setEvents] = useState<IntelEvent[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [rankByScore, setRankByScore] = useState(false);
  const [minScore, setMinScore] = useState(0.3);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSources()
      .then((all) => setSources(all.filter((s) => s.enabled)))
      .catch(() => setSources([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    getEvents({
      rank: rankByScore ? 'score' : 'recency',
      query: query || undefined,
      kinds: kinds.length ? kinds : undefined,
      sourceId: sourceId || undefined,
      minScore: rankByScore ? minScore : undefined,
      limit: 100,
    })
      .then((data) => {
        setEvents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [query, kinds, sourceId, rankByScore, minScore]);

  const sourceMap = new Map(sources.map((s) => [s.id, s]));

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search events..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
        />
        <select
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', minWidth: 180, fontSize: 14 }}
        >
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {sourceKindIcons[s.kind] ?? '📡'} {s.name}
            </option>
          ))}
        </select>
        <select
          multiple
          value={kinds}
          onChange={(e) => setKinds(Array.from(e.target.selectedOptions).map((o) => o.value))}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #ccc', minWidth: 140, fontSize: 14 }}
        >
          {['visual', 'text', 'anomaly', 'alert', 'social_post', 'detection'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: '#374151',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={rankByScore}
            onChange={(e) => setRankByScore(e.target.checked)}
          />
          Rank by importance
        </label>
        {rankByScore && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' }}>
            min score
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#6b7280', minWidth: 28 }}>
              {(minScore * 100).toFixed(0)}
            </span>
          </label>
        )}
        {(query || kinds.length > 0 || sourceId || rankByScore) && (
          <button
            onClick={() => {
              setQuery('');
              setKinds([]);
              setSourceId('');
              setRankByScore(false);
              setMinScore(0.3);
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
        {loading ? 'Loading...' : `${events.length.toLocaleString()} event${events.length === 1 ? '' : 's'} found`}
      </div>

      {/* Events list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {events.map((event) => {
          const source = sourceMap.get(event.sourceId);
          return (
            <div
              key={event.id}
              style={{
                padding: 16,
                borderRadius: 8,
                border: '1px solid #e5e7eb',
                background: '#fff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
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
                {source && (
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {sourceKindIcons[source.kind] ?? '📡'} {source.name}
                  </span>
                )}
                <span style={{ fontSize: 12, color: '#666' }}>
                  {new Date(event.eventAt).toLocaleString()}
                </span>
                <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
                  {(event.confidence * 100).toFixed(0)}% confidence
                </span>
                {event.score != null && (
                  <span
                    title="Composite importance score"
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: scoreColor(event.score),
                      color: '#fff',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {(event.score * 100).toFixed(0)}
                  </span>
                )}
              </div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{event.title ?? 'Untitled'}</div>
              {'link' in event.tags && typeof event.tags.link === 'string' && event.tags.link.startsWith('http') && (
                <a
                  href={event.tags.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: 'inline-block', fontSize: 13, color: '#2563eb', marginBottom: 6, textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  🔗 {event.tags.link}
                </a>
              )}
              <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.5 }}>
                <LinkifyText text={event.content} />
              </div>
              {event.location && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                  📍 {event.location.lat.toFixed(4)}, {event.location.lon.toFixed(4)}
                </div>
              )}
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
          );
        })}
      </div>
    </div>
  );
}
