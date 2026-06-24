import { useEffect, useMemo, useState } from 'react';
import {
  getSignals,
  getSignal,
  setSignalTriage,
  muteSignal,
  unmuteSignal,
  unmuteKey,
  listSignalMutes,
} from '../lib/api.js';
import type {
  IntelEvent,
  IntelSignal,
  RiskBand,
  SignalKind,
  SignalMute,
  TriageState,
} from '../lib/types.js';
import { signalColors, scoreColor, colors, rgb } from '../lib/theme.js';

// Operator console for the cross-stream intelligence signals emitted by the MIT
// "brain" layer. Each kind gets a distinct accent color so an operator can scan
// groups at a glance. 006 adds triage (acknowledge/dismiss/mute), risk bands,
// drill-down into member events, and a muted-keys view.

const KIND_ORDER: SignalKind[] = [
  'convergence',
  'geo_convergence',
  'velocity_spike',
  'silent_source',
  'volume_anomaly',
  'cluster_surge',
  'outlier',
  'uncorroborated',
  'rule_match',
];

const kindIcons: Record<SignalKind, string> = {
  convergence: '🔀',
  geo_convergence: '🗺️',
  velocity_spike: '⚡',
  silent_source: '🔇',
  volume_anomaly: '📈',
  cluster_surge: '🌊',
  outlier: '🎯',
  uncorroborated: '❓',
  rule_match: '📐',
};

const kindLabels: Record<SignalKind, string> = {
  convergence: 'Convergence',
  geo_convergence: 'Geo convergence',
  velocity_spike: 'Velocity spike',
  silent_source: 'Silent source',
  volume_anomaly: 'Volume anomaly',
  cluster_surge: 'Cluster surge',
  outlier: 'Outlier',
  uncorroborated: 'Uncorroborated',
  rule_match: 'Rule match',
};

// Extend the shared signalColors map with accents for the 006 kinds. The base
// map (theme.ts) doesn't include them, so fall back here.
const KIND_COLOR_FALLBACK: Record<string, string> = {
  outlier: colors.elevated,
  uncorroborated: colors.muted,
  rule_match: colors.purple,
};
function kindColor(kind: SignalKind): string {
  return signalColors[kind] ?? KIND_COLOR_FALLBACK[kind] ?? colors.dim;
}

// Risk-band badge palette (mirrors the severity neon semantics).
const riskBandColors: Record<RiskBand, string> = {
  HIGH: colors.critical,
  MEDIUM: colors.high,
  LOW: colors.low,
  INFO: colors.info,
};

// Triage-state badge styling.
const triageLabels: Record<TriageState, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  dismissed: 'Dismissed',
};
const triageColors: Record<TriageState, string> = {
  open: colors.dim,
  acknowledged: colors.live,
  dismissed: colors.muted,
};

// Mute duration presets (label -> ms offset, or null for permanent).
const MUTE_DURATIONS: { label: string; ms: number | null }[] = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Permanent', ms: null },
];

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function untilLabel(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return 'expired';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

const REFRESH_MS = 20_000;

interface DrillState {
  loading: boolean;
  signal?: IntelSignal;
  events?: IntelEvent[];
  error?: string;
}

export default function SignalsPanel() {
  const [signals, setSignals] = useState<IntelSignal[]>([]);
  const [kinds, setKinds] = useState<SignalKind[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-signal busy flag (during a triage/mute action) and expanded drill-down.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drill, setDrill] = useState<Record<string, DrillState>>({});

  // Muted-keys view.
  const [mutes, setMutes] = useState<SignalMute[]>([]);
  const [showMutes, setShowMutes] = useState(false);
  const [mutesLoading, setMutesLoading] = useState(false);

  function load() {
    getSignals({ limit: 100, includeDismissed })
      .then((data) => {
        setSignals(data);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load signals');
        setLoading(false);
      });
  }

  useEffect(() => {
    let alive = true;
    const tick = () => {
      getSignals({ limit: 100, includeDismissed })
        .then((data) => {
          if (!alive) return;
          setSignals(data);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : 'Failed to load signals');
          setLoading(false);
        });
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // Re-load (and reset the poll) whenever the dismissed toggle flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDismissed]);

  async function refreshMutes() {
    setMutesLoading(true);
    try {
      setMutes(await listSignalMutes());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load mutes');
    } finally {
      setMutesLoading(false);
    }
  }

  function toggleMutes() {
    const next = !showMutes;
    setShowMutes(next);
    if (next) refreshMutes();
  }

  async function onTriage(sig: IntelSignal & { groupIds?: string[] }, state: TriageState) {
    // Act on every firing collapsed under this card (one Dismiss clears them all).
    const ids = sig.groupIds?.length ? sig.groupIds : [sig.id];
    setBusyId(sig.id);
    setError(null);
    try {
      await Promise.all(ids.map((id) => setSignalTriage(id, state)));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update triage');
    } finally {
      setBusyId(null);
    }
  }

  async function onMute(sig: IntelSignal, ms: number | null) {
    setBusyId(sig.id);
    setError(null);
    try {
      const mutedUntil = ms === null ? null : Date.now() + ms;
      await muteSignal(sig.id, mutedUntil);
      load();
      if (showMutes) refreshMutes();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mute signal');
    } finally {
      setBusyId(null);
    }
  }

  async function onUnmute(sig: IntelSignal) {
    setBusyId(sig.id);
    setError(null);
    try {
      await unmuteSignal(sig.id);
      load();
      if (showMutes) refreshMutes();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unmute signal');
    } finally {
      setBusyId(null);
    }
  }

  async function onUnmuteKey(sig: SignalMute) {
    // The mutes list is keyed by dedupeKey; unmute by that key via the API.
    setError(null);
    try {
      await unmuteKey(sig.dedupeKey);
      await refreshMutes();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unmute key');
    }
  }

  async function onToggleDrill(sig: IntelSignal) {
    if (expanded === sig.id) {
      setExpanded(null);
      return;
    }
    setExpanded(sig.id);
    // Fetch member events once per signal (re-fetch only if a prior error).
    const prior = drill[sig.id];
    if (prior && !prior.error && prior.events) return;
    setDrill((d) => ({ ...d, [sig.id]: { loading: true } }));
    try {
      const { signal, events } = await getSignal(sig.id);
      setDrill((d) => ({ ...d, [sig.id]: { loading: false, signal, events } }));
    } catch (e) {
      setDrill((d) => ({
        ...d,
        [sig.id]: { loading: false, error: e instanceof Error ? e.message : 'Failed to load events' },
      }));
    }
  }

  // Filter (kind multiselect + minScore), bucket by kind, then COLLAPSE repeats
  // that share a dedupe key (e.g. a feed that went silent and re-fired over many
  // days) into ONE card: the latest representative + a fired-count + the full id
  // list, so a single Acknowledge/Dismiss clears the whole group.
  const groups = useMemo(() => {
    const filtered = signals.filter(
      (s) => s.score >= minScore && (kinds.length === 0 || kinds.includes(s.kind)),
    );
    return KIND_ORDER.map((kind) => {
      const byKey = new Map<string, IntelSignal[]>();
      for (const s of filtered) {
        if (s.kind !== kind) continue;
        const key = s.dedupeKey || `${s.kind}::${s.title}`;
        const arr = byKey.get(key);
        if (arr) arr.push(s);
        else byKey.set(key, [s]);
      }
      const items = [...byKey.values()]
        .map((arr) => {
          arr.sort((a, b) => b.createdAt - a.createdAt); // latest is the representative
          return { ...arr[0], count: arr.length, groupIds: arr.map((s) => s.id) };
        })
        .sort((a, b) => b.score - a.score);
      return { kind, items };
    }).filter((g) => g.items.length > 0);
  }, [signals, kinds, minScore]);

  const totalShown = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          multiple
          className="wm-select"
          value={kinds}
          onChange={(e) =>
            setKinds(Array.from(e.target.selectedOptions).map((o) => o.value as SignalKind))
          }
          style={{ minWidth: 180 }}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {kindIcons[k]} {kindLabels[k]}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--wm-text)' }}>
          <span style={{ whiteSpace: 'nowrap' }}>Min score</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            style={{ width: 160 }}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28, fontWeight: 600 }}>
            {minScore}
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--wm-text)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeDismissed}
            onChange={(e) => setIncludeDismissed(e.target.checked)}
          />
          <span style={{ whiteSpace: 'nowrap' }}>Show dismissed</span>
        </label>
        <button
          className="wm-btn"
          onClick={toggleMutes}
          style={{ cursor: 'pointer' }}
        >
          {showMutes ? 'Hide muted keys' : 'Muted keys'}
        </button>
        {(kinds.length > 0 || minScore > 0) && (
          <button
            className="wm-btn"
            onClick={() => {
              setKinds([]);
              setMinScore(0);
            }}
            style={{ cursor: 'pointer' }}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 3,
            border: `1px solid rgba(${rgb(colors.critical)}, 0.4)`,
            background: `rgba(${rgb(colors.critical)}, 0.12)`,
            color: colors.critical,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {/* Muted keys view */}
      {showMutes && (
        <div className="wm-card" style={{ padding: 16, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Muted keys</div>
          {mutesLoading ? (
            <div style={{ fontSize: 13, color: 'var(--wm-dim)' }}>Loading…</div>
          ) : mutes.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--wm-muted)' }}>No muted signal keys.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {mutes.map((m) => (
                <div
                  key={m.dedupeKey}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}
                >
                  <span className="wm-chip wm-meta" style={{ wordBreak: 'break-all' }}>🔕 {m.dedupeKey}</span>
                  <span style={{ color: 'var(--wm-dim)' }}>
                    {m.mutedUntil ? `until ${untilLabel(m.mutedUntil)}` : 'permanent'}
                  </span>
                  {m.reason && <span style={{ color: 'var(--wm-muted)' }}>“{m.reason}”</span>}
                  <button
                    className="wm-btn"
                    onClick={() => onUnmuteKey(m)}
                    style={{ marginLeft: 'auto', cursor: 'pointer' }}
                  >
                    Unmute
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results count */}
      <div style={{ fontSize: 13, color: 'var(--wm-dim)', marginBottom: 12 }}>
        {loading
          ? 'Loading...'
          : `${totalShown.toLocaleString()} signal${totalShown === 1 ? '' : 's'} across ${groups.length} group${groups.length === 1 ? '' : 's'}`}
      </div>

      {/* Grouped signals */}
      {!loading && groups.length === 0 && (
        <div style={{ fontSize: 14, color: 'var(--wm-muted)', padding: '40px 0', textAlign: 'center' }}>
          No signals match the current filters.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {groups.map((group) => {
          const accent = kindColor(group.kind);
          return (
            <div key={group.kind}>
              {/* Group header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                  paddingBottom: 6,
                  borderBottom: `2px solid ${accent}`,
                }}
              >
                <span style={{ fontSize: 16 }}>{kindIcons[group.kind]}</span>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: 'var(--wm-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  {kindLabels[group.kind]}
                </span>
                <span
                  className="wm-chip"
                  style={{ color: accent, borderColor: accent }}
                >
                  {group.items.length}
                </span>
              </div>

              {/* Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {group.items.map((sig) => {
                  const busy = busyId === sig.id;
                  const triage = sig.triageState ?? 'open';
                  const isMuted = sig.mutedUntil != null && sig.mutedUntil > Date.now();
                  const isOpen = expanded === sig.id;
                  const d = drill[sig.id];
                  return (
                    <div
                      key={sig.id}
                      className="wm-card"
                      style={{
                        padding: 16,
                        borderLeft: `3px solid ${accent}`,
                        opacity: triage === 'dismissed' ? 0.6 : 1,
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap', cursor: 'pointer' }}
                        onClick={() => onToggleDrill(sig)}
                      >
                        <span style={{ fontSize: 11, color: 'var(--wm-dim)', width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                        <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{sig.title}</span>
                        {sig.count > 1 && (
                          <span
                            className="wm-chip"
                            style={{ color: colors.dim, borderColor: colors.dim, fontVariantNumeric: 'tabular-nums' }}
                            title={`Fired ${sig.count} times — collapsed; Dismiss clears all`}
                          >
                            ×{sig.count}
                          </span>
                        )}
                        {sig.riskBand && (
                          <span
                            className="wm-chip"
                            style={{
                              color: riskBandColors[sig.riskBand],
                              borderColor: riskBandColors[sig.riskBand],
                              fontWeight: 700,
                              letterSpacing: 0.5,
                            }}
                          >
                            {sig.riskBand}
                          </span>
                        )}
                        <span
                          className="wm-chip"
                          style={{ color: triageColors[triage], borderColor: triageColors[triage] }}
                        >
                          {triageLabels[triage]}
                        </span>
                        {isMuted && (
                          <span className="wm-chip" style={{ color: colors.dim, borderColor: colors.dim }}>
                            🔕 {sig.mutedUntil ? untilLabel(sig.mutedUntil) : 'muted'}
                          </span>
                        )}
                        <span
                          className="wm-chip"
                          style={{
                            color: scoreColor(sig.score / 100),
                            borderColor: scoreColor(sig.score / 100),
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {sig.score.toFixed(0)}
                        </span>
                      </div>

                      {sig.summary && (
                        <div style={{ fontSize: 14, color: 'var(--wm-text-2)', lineHeight: 1.5, marginBottom: 8 }}>
                          {sig.summary}
                        </div>
                      )}

                      {/* Involved source chips */}
                      {sig.sourceIds && sig.sourceIds.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          {sig.sourceIds.map((sid) => (
                            <span key={sid} className="wm-chip wm-meta">
                              📡 {sid}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Meta row */}
                      <div className="wm-meta" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--wm-dim)' }}>
                        <span>
                          {(sig.eventIds?.length ?? 0).toLocaleString()} event
                          {(sig.eventIds?.length ?? 0) === 1 ? '' : 's'}
                        </span>
                        {sig.location && (
                          <span>
                            📍 {sig.location.lat.toFixed(4)}, {sig.location.lon.toFixed(4)}
                          </span>
                        )}
                        {sig.clusterId && <span>🧩 {sig.clusterId}</span>}
                        <span style={{ marginLeft: 'auto' }}>{relativeTime(sig.createdAt)}</span>
                      </div>

                      {/* Triage actions */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                        <button
                          className="wm-btn"
                          onClick={() => onTriage(sig, 'acknowledged')}
                          disabled={busy || triage === 'acknowledged'}
                          style={{ cursor: 'pointer' }}
                        >
                          Acknowledge
                        </button>
                        <button
                          className="wm-btn wm-btn--danger"
                          onClick={() => onTriage(sig, 'dismissed')}
                          disabled={busy || triage === 'dismissed'}
                          style={{ cursor: 'pointer' }}
                        >
                          Dismiss
                        </button>
                        {isMuted ? (
                          <button
                            className="wm-btn"
                            onClick={() => onUnmute(sig)}
                            disabled={busy}
                            style={{ cursor: 'pointer' }}
                          >
                            Unmute
                          </button>
                        ) : (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 12, color: 'var(--wm-muted)' }}>Mute:</span>
                            {MUTE_DURATIONS.map((dur) => (
                              <button
                                key={dur.label}
                                className="wm-btn"
                                onClick={() => onMute(sig, dur.ms)}
                                disabled={busy}
                                style={{ cursor: 'pointer', padding: '2px 8px', fontSize: 12 }}
                              >
                                {dur.label}
                              </button>
                            ))}
                          </span>
                        )}
                      </div>

                      {/* Drill-down: member events */}
                      {isOpen && (
                        <div
                          style={{
                            marginTop: 12,
                            paddingTop: 12,
                            borderTop: `1px solid var(--wm-border)`,
                          }}
                        >
                          {d?.loading && (
                            <div style={{ fontSize: 13, color: 'var(--wm-dim)' }}>Loading events…</div>
                          )}
                          {d?.error && (
                            <div style={{ fontSize: 13, color: colors.critical }}>{d.error}</div>
                          )}
                          {d && !d.loading && !d.error && (
                            <>
                              {(d.events?.length ?? 0) === 0 ? (
                                <div style={{ fontSize: 13, color: 'var(--wm-muted)' }}>
                                  No member events available (purged or expired).
                                </div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <div style={{ fontSize: 12, color: 'var(--wm-dim)', marginBottom: 2 }}>
                                    {d.events!.length} member event{d.events!.length === 1 ? '' : 's'}
                                  </div>
                                  {d.events!.map((ev) => (
                                    <div
                                      key={ev.id}
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        fontSize: 13,
                                        padding: '6px 8px',
                                        background: `rgba(${rgb(colors.hover)}, 0.5)`,
                                        borderRadius: 3,
                                      }}
                                    >
                                      <span className="wm-chip wm-meta">{ev.kind}</span>
                                      <span style={{ flex: 1, minWidth: 0, color: 'var(--wm-text-2)' }}>
                                        {ev.title || ev.content || ev.id}
                                      </span>
                                      {ev.riskBand && (
                                        <span
                                          className="wm-chip"
                                          style={{ color: riskBandColors[ev.riskBand], borderColor: riskBandColors[ev.riskBand] }}
                                        >
                                          {ev.riskBand}
                                        </span>
                                      )}
                                      {ev.score != null && (
                                        <span
                                          className="wm-chip"
                                          style={{
                                            color: scoreColor(ev.score / 100),
                                            borderColor: scoreColor(ev.score / 100),
                                            fontVariantNumeric: 'tabular-nums',
                                          }}
                                        >
                                          {ev.score.toFixed(0)}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
