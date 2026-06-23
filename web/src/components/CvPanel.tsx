import { useEffect, useMemo, useState } from 'react';
import { getSources, getCvAlerts, getCvDetail, cvSearch } from '../lib/api.js';
import type { CvAlertRow, Source } from '../lib/types.js';
import { colors, categoryColors, rgb } from '../lib/theme.js';

// CV (computer-vision sidecar) console — READ ONLY.
//
// The sidecar layer (zone/line counts, crowd density, alert firings, semantic
// search over redacted frames) is optional and frequently INACTIVE in prod, so
// every panel degrades to a friendly empty/notice state rather than crashing.
//
// Route shapes (src/routes/cv.ts + src/store/cv.ts — raw SQL, so snake_case):
//   GET /cv/alerts/:sourceId  -> { alerts: [{ id, event_id, rule_id, alert_type,
//                                   zone_id, line_id, value, threshold, severity, created_at }] }
//   GET /cv/detail/:sourceId  -> { counts: [{ zone_id, line_id, name, peak_occupancy,
//                                   in_count, out_count, class_counts, created_at }] }
//   GET /cv/search?q=...      -> { query, results: [{ event_id, source_id, caption,
//                                   created_at, distance }] }
// The loose CvAlertRow type is camelCase; we read snake_case first with camelCase
// fallbacks so this keeps working whichever the server emits.

// Source kinds that carry a camera feed (the only ones with CV analytics).
const CAMERA_KINDS = new Set(['webcam', 'traffic_cam', 'weather_cam', 'ip_camera']);

const sourceKindIcons: Record<string, string> = {
  webcam: '📹', traffic_cam: '🚗', weather_cam: '🌤️', ip_camera: '📡',
};

// Detail rows come straight from cv_zone_counts (snake_case, loosely typed).
interface CvCountRow {
  zone_id?: string | null;
  line_id?: string | null;
  name?: string | null;
  peak_occupancy?: number | null;
  in_count?: number | null;
  out_count?: number | null;
  class_counts?: Record<string, number> | string | null;
  created_at?: number;
  [k: string]: unknown;
}

// Search results from cv_embeddings (semantic nearest-frame).
interface CvSearchRow extends CvAlertRow {
  caption?: string;
  event_id?: string;
  source_id?: string;
  distance?: number;
}

// ---- small field helpers (snake_case first, camelCase fallback) ----
function alertType(r: CvAlertRow): string {
  return String(r.alert_type ?? r.type ?? r.ruleId ?? r.rule_id ?? 'detection');
}
function alertTime(r: CvAlertRow): number | undefined {
  const t = r.created_at ?? r.createdAt ?? r.eventAt ?? r.event_at;
  return typeof t === 'number' ? t : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const SEV_COLOR: Record<string, string> = {
  alert: colors.critical,
  record: colors.elevated,
  warn: colors.high,
  warning: colors.high,
  info: colors.info,
};
function severityColor(sev: unknown): string {
  return SEV_COLOR[String(sev ?? '').toLowerCase()] ?? colors.dim;
}

function relTime(ms: number | undefined, now: number): string {
  if (!ms) return '—';
  const d = now - ms;
  if (d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// class_counts can arrive as a JSON object or a stringified JSON blob.
function fmtClassCounts(cc: CvCountRow['class_counts']): string {
  let obj: Record<string, number> | undefined;
  if (typeof cc === 'string') {
    try { obj = JSON.parse(cc); } catch { return cc; }
  } else if (cc && typeof cc === 'object') {
    obj = cc as Record<string, number>;
  }
  if (!obj) return '';
  const parts = Object.entries(obj).filter(([, v]) => v != null);
  if (!parts.length) return '';
  return parts.map(([k, v]) => `${k}: ${v}`).join('  ');
}

function Notice({ icon, title, detail }: { icon: string; title: string; detail?: string }) {
  return (
    <div style={{ padding: 28, textAlign: 'center', color: 'var(--wm-dim)' }}>
      <div style={{ fontSize: 26, marginBottom: 8, opacity: 0.7 }}>{icon}</div>
      <div style={{ fontSize: 13, color: 'var(--wm-text-2)' }}>{title}</div>
      {detail && <div style={{ fontSize: 12, color: 'var(--wm-muted)', marginTop: 4 }}>{detail}</div>}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return <div style={{ padding: 24, textAlign: 'center', color: 'var(--wm-dim)', fontSize: 13 }}>{label}</div>;
}

export default function CvPanel() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState('');
  const [selectedId, setSelectedId] = useState('');

  // alerts + detail for the selected source
  const [alerts, setAlerts] = useState<CvAlertRow[]>([]);
  const [counts, setCounts] = useState<CvCountRow[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');

  // semantic search
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<CvSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Load sources once; pick the first camera source by default.
  useEffect(() => {
    let cancelled = false;
    getSources()
      .then((data) => {
        if (cancelled) return;
        setSources(data);
        setSourcesError('');
        setSourcesLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSourcesError('Failed to load sources');
        setSourcesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const cameras = useMemo(
    () => sources.filter((s) => CAMERA_KINDS.has(s.kind)).sort((a, b) => a.name.localeCompare(b.name)),
    [sources],
  );

  // Auto-select first camera once sources arrive.
  useEffect(() => {
    if (!selectedId && cameras.length > 0) setSelectedId(cameras[0].id);
  }, [cameras, selectedId]);

  const selected = useMemo(() => cameras.find((s) => s.id === selectedId), [cameras, selectedId]);

  // Load alerts + detail whenever the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setAlerts([]);
      setCounts([]);
      return;
    }
    let cancelled = false;
    setSourceLoading(true);
    setSourceError('');
    Promise.allSettled([getCvAlerts(selectedId, 50), getCvDetail(selectedId)])
      .then(([aRes, dRes]) => {
        if (cancelled) return;
        setAlerts(aRes.status === 'fulfilled' ? aRes.value : []);
        // getCvDetail returns `unknown` — the route wraps rows in { counts }.
        let rows: CvCountRow[] = [];
        if (dRes.status === 'fulfilled') {
          const payload = dRes.value as { counts?: CvCountRow[] } | CvCountRow[] | null;
          rows = Array.isArray(payload) ? payload : (payload?.counts ?? []);
        }
        setCounts(rows);
        // Only treat it as a hard error if BOTH reads failed (sidecar likely down).
        if (aRes.status === 'rejected' && dRes.status === 'rejected') {
          setSourceError('CV reads failed — sidecar may be offline');
        }
        setSourceLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    const q = searchInput.trim();
    if (!q) return;
    setSearchQuery(q);
    setSearching(true);
    setSearchError('');
    setSearched(true);
    cvSearch(q, 25)
      .then((rows) => {
        setResults(rows as CvSearchRow[]);
        setSearching(false);
      })
      .catch(() => {
        // Search 503s when CV_SEMANTIC_SEARCH is off / pgvector schema missing,
        // and 400s if the query param doesn't reach the route. Degrade softly.
        setResults([]);
        setSearchError('Semantic search unavailable (CV sidecar / pgvector not configured).');
        setSearching(false);
      });
  }

  const noCameras = !sourcesLoading && !sourcesError && cameras.length === 0;

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto', height: '100%', overflowY: 'auto', width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--wm-text)' }}>🎥 Computer Vision</h2>
        <span style={{ fontSize: 13, color: 'var(--wm-dim)' }}>
          {sourcesLoading
            ? 'Loading cameras…'
            : `${cameras.length} camera source${cameras.length === 1 ? '' : 's'} · zone/line counts, crowd density & alert firings`}
        </span>
      </div>

      {sourcesError && (
        <div style={{ padding: '10px 12px', borderRadius: 4, background: `rgba(${rgb(colors.critical)}, 0.10)`, color: 'var(--wm-critical)', fontSize: 13, marginBottom: 16 }}>
          {sourcesError}
        </div>
      )}

      {/* Source picker */}
      {cameras.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--wm-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Camera
          </label>
          <select
            className="wm-select"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{ minWidth: 240 }}
          >
            {cameras.map((s) => (
              <option key={s.id} value={s.id}>
                {(sourceKindIcons[s.kind] ?? '📷') + ' '}{s.name} · {s.kind.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {selected && !selected.enabled && (
            <span className="wm-chip wm-chip--outline" style={{ color: 'var(--wm-muted)' }}>disabled</span>
          )}
        </div>
      )}

      {noCameras && (
        <div className="wm-card" style={{ marginBottom: 20 }}>
          <Notice
            icon="📷"
            title="No camera sources configured"
            detail="CV analytics require a webcam / traffic_cam / weather_cam / ip_camera source."
          />
        </div>
      )}

      {/* Per-source: alerts + detail */}
      {selected && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16, marginBottom: 20 }}>
          {/* Recent alert firings */}
          <div className="wm-panel" style={{ maxHeight: 460 }}>
            <div className="wm-panel__head">
              <span>Recent Alerts</span>
              <span className="wm-panel__count">{sourceLoading ? '' : alerts.length}</span>
            </div>
            <div className="wm-panel__body" style={{ padding: 0 }}>
              {sourceLoading ? (
                <Spinner label="Loading alerts…" />
              ) : sourceError ? (
                <Notice icon="🛑" title={sourceError} />
              ) : alerts.length === 0 ? (
                <Notice icon="✅" title="No recent CV alerts" detail="No alert rules fired in the last 24h." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {alerts.map((a, i) => {
                    const v = num(a.value);
                    const th = num(a.threshold);
                    const sevColor = severityColor(a.severity);
                    const zone = (a.zone_id ?? a.zoneId) as string | undefined;
                    const line = (a.line_id ?? a.lineId) as string | undefined;
                    return (
                      <div
                        key={String(a.id ?? i)}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 10,
                          padding: '10px 12px',
                          borderBottom: '1px solid var(--wm-border-subtle)',
                          borderLeft: `3px solid ${sevColor}`,
                        }}
                      >
                        <span className="wm-dot" style={{ background: sevColor, color: sevColor, marginTop: 5 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--wm-text)' }}>
                              {alertType(a)}
                            </span>
                            {a.severity != null && (
                              <span className="wm-chip wm-chip--outline" style={{ color: sevColor }}>
                                {String(a.severity)}
                              </span>
                            )}
                            <span className="wm-meta" style={{ marginLeft: 'auto', fontSize: 11 }}>
                              {relTime(alertTime(a), now)}
                            </span>
                          </div>
                          <div className="wm-meta" style={{ marginTop: 4, fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            {v !== undefined && (
                              <span>
                                value <span style={{ color: 'var(--wm-text-2)' }}>{v}</span>
                                {th !== undefined && <span style={{ color: 'var(--wm-muted)' }}> / thr {th}</span>}
                              </span>
                            )}
                            {zone && <span>zone <span style={{ color: 'var(--wm-text-2)' }}>{zone}</span></span>}
                            {line && <span>line <span style={{ color: 'var(--wm-text-2)' }}>{line}</span></span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Detail: zone/line counts + crowd density */}
          <div className="wm-panel" style={{ maxHeight: 460 }}>
            <div className="wm-panel__head">
              <span>Zone / Line Counts</span>
              <span className="wm-panel__count">{sourceLoading ? '' : counts.length}</span>
            </div>
            <div className="wm-panel__body" style={{ padding: 0 }}>
              {sourceLoading ? (
                <Spinner label="Loading detail…" />
              ) : counts.length === 0 ? (
                <Notice icon="📊" title="No zone/line counts" detail="No CV aggregates recorded for this camera." />
              ) : (
                <table className="wm-table">
                  <thead>
                    <tr>
                      <th>Zone / Line</th>
                      <th>Peak</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Classes</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {counts.map((c, i) => {
                      const isLine = c.line_id != null;
                      const label = c.name || c.zone_id || c.line_id || '—';
                      const cc = fmtClassCounts(c.class_counts);
                      return (
                        <tr key={`${c.zone_id ?? c.line_id ?? 'row'}-${i}`}>
                          <td style={{ color: 'var(--wm-text)' }}>
                            <span style={{ color: isLine ? colors.teal : colors.low, marginRight: 5 }}>
                              {isLine ? '⇄' : '▣'}
                            </span>
                            {String(label)}
                          </td>
                          <td>{num(c.peak_occupancy) ?? '—'}</td>
                          <td>{num(c.in_count) ?? '—'}</td>
                          <td>{num(c.out_count) ?? '—'}</td>
                          <td style={{ color: 'var(--wm-dim)', maxWidth: 160, whiteSpace: 'normal' }}>{cc || '—'}</td>
                          <td className="wm-meta" style={{ fontSize: 11 }}>{relTime(num(c.created_at), now)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Semantic CV search (over de-identified alert frames) */}
      <div className="wm-panel">
        <div className="wm-panel__head">
          <span>Semantic Frame Search</span>
          {searched && !searching && <span className="wm-panel__count">{results.length}</span>}
        </div>
        <div className="wm-panel__body">
          <form onSubmit={runSearch} style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              className="wm-input"
              placeholder="e.g. crowd gathering at night, white truck…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <button type="submit" className="wm-btn wm-btn--primary" disabled={searching || !searchInput.trim()}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>

          {searchError && (
            <Notice icon="🔌" title={searchError} />
          )}

          {!searchError && searching && <Spinner label="Searching frames…" />}

          {!searchError && !searching && searched && results.length === 0 && (
            <Notice icon="🔍" title="No matching frames" detail={`Nothing close to “${searchQuery}”.`} />
          )}

          {!searchError && !searching && results.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {results.map((r, i) => {
                const cap = r.caption ?? (typeof r.content === 'string' ? r.content : '') ?? '';
                const dist = num(r.distance);
                const sid = r.source_id ?? r.sourceId;
                return (
                  <div key={String(r.event_id ?? r.id ?? i)} className="wm-card" style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, color: 'var(--wm-text)', flex: 1, minWidth: 0 }}>
                        {cap || <span style={{ color: 'var(--wm-muted)' }}>(no caption)</span>}
                      </span>
                      {dist !== undefined && (
                        <span
                          className="wm-chip wm-chip--outline"
                          style={{ color: categoryColors.default }}
                          title="cosine distance (lower = closer)"
                        >
                          d {dist.toFixed(3)}
                        </span>
                      )}
                    </div>
                    <div className="wm-meta" style={{ marginTop: 4, fontSize: 11, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {sid && <span>src {String(sid)}</span>}
                      <span>{relTime(alertTime(r), now)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!searched && !searchError && (
            <div style={{ fontSize: 12, color: 'var(--wm-muted)' }}>
              Searches de-identified alert frames by CLIP embedding. Requires the CV sidecar with
              semantic search enabled — otherwise it degrades to an unavailable notice.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
