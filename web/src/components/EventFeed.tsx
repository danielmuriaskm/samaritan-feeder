import { useEffect, useState, type ReactNode } from 'react';
import { getEvents, getSources, eventsExportUrl, DATA_CLASSES, RISK_BANDS, type EventQuery } from '../lib/api.js';
import type { DataClass, IntelEvent, RiskBand, Source } from '../lib/types.js';
import { colors, kindColors, scoreColor } from '../lib/theme.js';

// Risk-band → neon accent (mirrors severity grading in theme.scoreColor).
const riskBandColors: Record<RiskBand, string> = {
  HIGH: colors.critical,
  MEDIUM: colors.high,
  LOW: colors.low,
  INFO: colors.dim,
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
        style={{ color: 'var(--wm-info)', textDecoration: 'underline', wordBreak: 'break-all' }}
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
  const [mode, setMode] = useState<EventQuery['mode']>('contains');
  const [kinds, setKinds] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [dataClass, setDataClass] = useState<DataClass | ''>('');
  const [riskBand, setRiskBand] = useState<RiskBand | ''>('');
  const [rankByScore, setRankByScore] = useState(false);
  const [minScore, setMinScore] = useState(0.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    getSources()
      .then((all) => setSources(all.filter((s) => s.enabled)))
      .catch(() => setSources([]));
  }, []);

  // The query that drives both the feed and the export links.
  const eventQuery: EventQuery = {
    rank: rankByScore ? 'score' : 'recency',
    query: query || undefined,
    mode: query && mode !== 'contains' ? mode : undefined,
    kinds: kinds.length ? kinds : undefined,
    sourceId: sourceId || undefined,
    dataClass: dataClass || undefined,
    riskBand: riskBand || undefined,
    minScore: rankByScore ? minScore : undefined,
    limit: 100,
  };

  useEffect(() => {
    setLoading(true);
    setError(false);
    getEvents(eventQuery)
      .then((data) => {
        setEvents(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, kinds, sourceId, dataClass, riskBand, rankByScore, minScore]);

  const sourceMap = new Map(sources.map((s) => [s.id, s]));

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="wm-input"
          type="text"
          placeholder={
            mode === 'wildcard' ? 'Search events... (e.g. *term*)'
            : mode === 'regex' ? 'Search events... (regex)'
            : 'Search events...'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 200, fontSize: 14 }}
        />
        <select
          className="wm-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as EventQuery['mode'])}
          title="Match mode — the store also parses *term* (wildcard) and /regex/ inline"
          style={{ minWidth: 110, fontSize: 14 }}
        >
          <option value="contains">contains</option>
          <option value="wildcard">wildcard</option>
          <option value="regex">regex</option>
        </select>
        <select
          className="wm-select"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          style={{ minWidth: 180, fontSize: 14 }}
        >
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {sourceKindIcons[s.kind] ?? '📡'} {s.name}
            </option>
          ))}
        </select>
        <select
          className="wm-select"
          multiple
          value={kinds}
          onChange={(e) => setKinds(Array.from(e.target.selectedOptions).map((o) => o.value))}
          style={{ minWidth: 140, fontSize: 14 }}
        >
          {['visual', 'text', 'anomaly', 'alert', 'social_post', 'detection'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          className="wm-select"
          value={dataClass}
          onChange={(e) => setDataClass(e.target.value as DataClass | '')}
          title="Filter by data class"
          style={{ minWidth: 150, fontSize: 14 }}
        >
          <option value="">All classes</option>
          {DATA_CLASSES.map((dc) => (
            <option key={dc} value={dc}>
              {dc}
            </option>
          ))}
        </select>
        <select
          className="wm-select"
          value={riskBand}
          onChange={(e) => setRiskBand(e.target.value as RiskBand | '')}
          title="Filter by risk band"
          style={{ minWidth: 130, fontSize: 14 }}
        >
          <option value="">All risk</option>
          {RISK_BANDS.map((rb) => (
            <option key={rb} value={rb}>
              {rb}
            </option>
          ))}
        </select>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: 'var(--wm-dim)',
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--wm-dim)' }}>
            min score
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--wm-dim)', minWidth: 28 }}>
              {(minScore * 100).toFixed(0)}
            </span>
          </label>
        )}
        {(query || kinds.length > 0 || sourceId || dataClass || riskBand || rankByScore || mode !== 'contains') && (
          <button
            className="wm-btn"
            onClick={() => {
              setQuery('');
              setMode('contains');
              setKinds([]);
              setSourceId('');
              setDataClass('');
              setRiskBand('');
              setRankByScore(false);
              setMinScore(0.3);
            }}
            style={{ fontSize: 13 }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Export — download the current filtered query (006). Native <a download>; the browser fetches. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Export:</span>
        <a
          className="wm-btn"
          href={eventsExportUrl(eventQuery, 'csv')}
          download
          style={{ fontSize: 13, textDecoration: 'none' }}
        >
          ⬇ CSV
        </a>
        <a
          className="wm-btn"
          href={eventsExportUrl(eventQuery, 'ndjson')}
          download
          style={{ fontSize: 13, textDecoration: 'none' }}
        >
          ⬇ NDJSON
        </a>
      </div>

      {/* Results count */}
      <div className="wm-meta" style={{ fontSize: 13, marginBottom: 12 }}>
        {loading
          ? 'Loading...'
          : error
          ? <span style={{ color: 'var(--wm-critical)' }}>Failed to load events. Try adjusting filters or retry.</span>
          : `${events.length.toLocaleString()} event${events.length === 1 ? '' : 's'} found`}
      </div>

      {/* Events list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {events.map((event) => {
          const source = sourceMap.get(event.sourceId);
          return (
            <div key={event.id} className="wm-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
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
                {event.riskBand && (
                  <span
                    className="wm-chip"
                    title="Risk band"
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      background: riskBandColors[event.riskBand],
                    }}
                  >
                    {event.riskBand}
                  </span>
                )}
                {event.dataClass && (
                  <span
                    title="Data class"
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 4,
                      border: '1px solid var(--wm-border-strong)',
                      color: 'var(--wm-text-2)',
                    }}
                  >
                    {event.dataClass}
                  </span>
                )}
                {source && (
                  <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>
                    {sourceKindIcons[source.kind] ?? '📡'} {source.name}
                  </span>
                )}
                <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>
                  {new Date(event.eventAt).toLocaleString()}
                </span>
                <span style={{ fontSize: 12, color: 'var(--wm-dim)', marginLeft: 'auto' }}>
                  {(event.confidence * 100).toFixed(0)}% confidence
                </span>
                {event.score != null && (
                  <span
                    className="wm-chip"
                    title="Composite importance score"
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      background: scoreColor(event.score),
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
                  style={{ display: 'inline-block', fontSize: 13, color: 'var(--wm-info)', marginBottom: 6, textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  🔗 {event.tags.link}
                </a>
              )}
              <div style={{ fontSize: 14, color: 'var(--wm-text-2)', lineHeight: 1.5 }}>
                <LinkifyText text={event.content} />
              </div>
              {event.location && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--wm-dim)' }}>
                  📍 {event.location.lat.toFixed(4)}, {event.location.lon.toFixed(4)}
                </div>
              )}
              {Object.keys(event.tags).length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {Object.entries(event.tags).map(([k, v]) => (
                    <span key={k} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--wm-hover)', color: 'var(--wm-dim)', borderRadius: 4 }}>
                      {k}: {String(v).slice(0, 30)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!loading && !error && events.length === 0 && (
          <div className="wm-card" style={{ padding: 24, textAlign: 'center', color: 'var(--wm-dim)', fontSize: 14 }}>
            No events match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}
