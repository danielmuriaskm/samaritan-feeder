import { useEffect, useState } from 'react';
import { getDiscover, getDiscoverStats, type DiscoverTile, type DiscoverStats } from '../lib/api.js';
import { colors, scoreColor } from '../lib/theme.js';

// Perplexity-Discover-style feed: LLM-synthesized topic tiles from recent high-signal
// events. Served from the feeder's /discover (12-min server cache), so polling is cheap.

function rel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 0) return 'now';
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Stable-ish accent per category so the same topic keeps its color.
const CATEGORY_HUES = [colors.low, colors.teal, colors.purple, colors.high, colors.normal, colors.pink, colors.elevated, colors.info];
function categoryColor(cat: string): string {
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return CATEGORY_HUES[h % CATEGORY_HUES.length];
}

export default function DiscoverPanel() {
  const [tiles, setTiles] = useState<DiscoverTile[]>([]);
  const [stats, setStats] = useState<DiscoverStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    Promise.all([getDiscover(30), getDiscoverStats()])
      .then(([t, s]) => {
        setTiles(t);
        setStats(s);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    load();
    const id = setInterval(() => load(false), 90_000); // server caches 12m; this just picks up refreshes
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.5, color: 'var(--wm-text)' }}>🧭 Discover</span>
        {stats && (
          <span className="wm-meta">
            {stats.tiles} tiles · {stats.eventsConsidered} events{stats.model ? ` · ${stats.model}` : ''} · refreshed {rel(stats.lastRefresh)}
          </span>
        )}
        <button className="wm-btn" style={{ marginLeft: 'auto', fontSize: 13 }} onClick={() => load()} disabled={loading}>
          {loading ? 'Synthesizing…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="wm-card" style={{ padding: 14, marginBottom: 12, color: 'var(--wm-critical)', background: `rgba(255,68,68,0.10)` }}>
          Failed to load discover: {error}
        </div>
      )}

      {loading && !tiles.length && <div className="wm-meta">Synthesizing topics from recent events…</div>}

      {!loading && !error && !tiles.length && (
        <div className="wm-meta">No discover tiles yet — they synthesize from recent high-signal events.</div>
      )}

      {/* tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12, alignItems: 'start' }}>
        {tiles.map((t) => {
          const accent = categoryColor(t.category);
          return (
            <div
              key={t.id}
              className="wm-card wm-card--hover"
              style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `3px solid ${accent}` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="wm-chip" style={{ background: accent }}>{t.category}</span>
                {t.generatedBy === 'deterministic' && (
                  <span className="wm-chip wm-chip--outline" style={{ color: 'var(--wm-muted)' }} title="LLM unavailable — raw fallback">
                    raw
                  </span>
                )}
                {Number.isFinite(t.score) && (
                  <span className="wm-chip" title="topic salience" style={{ marginLeft: 'auto', background: scoreColor(t.score) }}>
                    {(t.score * 100).toFixed(0)}
                  </span>
                )}
              </div>

              <div style={{ fontWeight: 600, fontSize: 16, lineHeight: 1.3, color: 'var(--wm-text)' }}>{t.title}</div>
              <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--wm-text-2)' }}>{t.summary}</div>

              <div className="wm-meta" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                {t.sources.slice(0, 5).map((s, i) => (
                  <span key={`${s.sourceId}-${i}`} style={{ color: 'var(--wm-dim)' }}>
                    {s.kind ?? s.sourceId}
                    {s.count ? ` ×${s.count}` : ''}
                  </span>
                ))}
                <span style={{ marginLeft: 'auto', color: 'var(--wm-muted)' }}>
                  {t.eventIds.length} ev · {rel(t.updatedAt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
