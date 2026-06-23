import { useEffect, useMemo, useState } from 'react';
import { listSubscriptions, createSubscription, deleteSubscription, getSources } from '../lib/api.js';
import type { DeliveryMode, Source, Subscription } from '../lib/types.js';
import { colors, kindColors, rgb } from '../lib/theme.js';

const USER_ID = 'operator';

const DELIVERY_MODES: DeliveryMode[] = ['passive', 'proactive', 'alert'];

// Authoritative list mirrors the server enum in src/routes/subscriptions.ts.
const EVENT_KINDS = ['visual', 'text', 'anomaly', 'trend', 'alert', 'social_post'] as const;
type EventKind = (typeof EVENT_KINDS)[number];

const DEFAULT_MIN_CONFIDENCE = 0.6;

const deliveryModeMeta: Record<DeliveryMode, { label: string; color: string; hint: string }> = {
  passive: { label: 'Passive', color: colors.dim, hint: 'Only surfaced on demand (no push)' },
  proactive: { label: 'Proactive', color: colors.low, hint: 'Pushed to channels as it arrives' },
  alert: { label: 'Alert', color: colors.critical, hint: 'High-priority push, bypasses quiet hours' },
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export default function SubscriptionsPanel() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sourceId, setSourceId] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>('passive');
  const [minConfidence, setMinConfidence] = useState(DEFAULT_MIN_CONFIDENCE);
  const [filterQuery, setFilterQuery] = useState('');
  const [allowedKinds, setAllowedKinds] = useState<EventKind[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // sourceId -> display name, for resolving the list rows.
  const sourceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.id, s.name);
    return map;
  }, [sources]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [subs, srcs] = await Promise.all([listSubscriptions(USER_ID), getSources()]);
      setSubscriptions(subs);
      setSources(srcs);
      // Default the picker to the first source once we know what exists.
      setSourceId((prev) => prev || srcs[0]?.id || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load subscriptions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const canSubmit = sourceId.trim().length > 0 && !submitting;

  function toggleKind(k: EventKind) {
    setAllowedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  async function onAdd() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const filter = filterQuery.trim();
      await createSubscription({
        userId: USER_ID,
        sourceId,
        deliveryMode,
        minConfidence: clamp01(minConfidence),
        filterQuery: filter ? filter : undefined,
        allowedKinds: allowedKinds.length ? allowedKinds : undefined,
      });
      // Reset the optional fields; keep the source/mode for rapid repeat entry.
      setFilterQuery('');
      setAllowedKinds([]);
      setMinConfidence(DEFAULT_MIN_CONFIDENCE);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create subscription');
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(sub: Subscription) {
    const label = sourceNames.get(sub.sourceId) ?? sub.sourceId;
    if (!window.confirm(`Delete the subscription to "${label}"? This cannot be undone.`)) return;
    setBusyId(sub.id);
    setError(null);
    try {
      await deleteSubscription(sub.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete subscription');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 760, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      <div style={{ fontSize: 13, color: 'var(--wm-muted)', marginBottom: 16, lineHeight: 1.5 }}>
        Subscriptions decide <strong style={{ color: 'var(--wm-text-2)' }}>which</strong> events from a source get
        delivered and in what mode; channels (the Channels tab) decide <strong style={{ color: 'var(--wm-text-2)' }}>where</strong>.
      </div>

      {/* Add subscription form */}
      <div className="wm-card" style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Add subscription</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Source</span>
            <select
              className="wm-select"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              disabled={sources.length === 0}
            >
              {sources.length === 0 && <option value="">No sources available</option>}
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.kind})
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Delivery mode</span>
            <select
              className="wm-select"
              value={deliveryMode}
              onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}
            >
              {DELIVERY_MODES.map((m) => (
                <option key={m} value={m}>
                  {deliveryModeMeta[m].label} — {deliveryModeMeta[m].hint}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>
              Min confidence: {minConfidence.toFixed(2)}
            </span>
            <input
              className="wm-input"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minConfidence}
              onChange={(e) => setMinConfidence(clamp01(Number(e.target.value)))}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Filter query (optional keyword)</span>
            <input
              className="wm-input"
              type="text"
              value={filterQuery}
              placeholder="e.g. wildfire"
              onChange={(e) => setFilterQuery(e.target.value)}
            />
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>
              Allowed kinds (optional — all kinds delivered if none selected)
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {EVENT_KINDS.map((k) => {
                const on = allowedKinds.includes(k);
                const accent = kindColors[k] ?? colors.dim;
                return (
                  <button
                    key={k}
                    type="button"
                    className="wm-chip"
                    onClick={() => toggleKind(k)}
                    style={{
                      cursor: 'pointer',
                      border: `1px solid rgba(${rgb(accent)}, ${on ? 0.7 : 0.25})`,
                      background: on ? `rgba(${rgb(accent)}, 0.18)` : 'transparent',
                      color: on ? accent : 'var(--wm-dim)',
                    }}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="wm-btn wm-btn--primary" onClick={onAdd} disabled={!canSubmit}>
              {submitting ? 'Adding…' : 'Add subscription'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--wm-muted)' }}>
              Applies to user <code>{USER_ID}</code>.
            </span>
          </div>
        </div>
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

      <div style={{ fontSize: 13, color: 'var(--wm-dim)', marginBottom: 12 }}>
        {loading
          ? 'Loading…'
          : `${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}`}
      </div>

      {/* Subscription list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!loading && subscriptions.length === 0 && (
          <div style={{ fontSize: 14, color: 'var(--wm-muted)', textAlign: 'center', padding: 24 }}>
            No subscriptions yet. Add one above to control which events get delivered.
          </div>
        )}
        {subscriptions.map((sub) => {
          const busy = busyId === sub.id;
          const mode = deliveryModeMeta[sub.deliveryMode] ?? deliveryModeMeta.passive;
          const name = sourceNames.get(sub.sourceId);
          return (
            <div key={sub.id} className="wm-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{name ?? sub.sourceId}</span>
                {!name && (
                  <span style={{ fontSize: 11, color: 'var(--wm-muted)' }}>(source not found)</span>
                )}
                <span
                  className="wm-chip"
                  style={{
                    background: `rgba(${rgb(mode.color)}, 0.15)`,
                    color: mode.color,
                  }}
                >
                  {mode.label}
                </span>
                <span style={{ fontSize: 12, color: 'var(--wm-dim)', marginLeft: 'auto' }}>
                  {new Date(sub.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div className="wm-meta" style={{ fontSize: 13, color: 'var(--wm-text-2)', marginBottom: 12 }}>
                <div>min confidence: {sub.minConfidence.toFixed(2)}</div>
                {sub.filterQuery && <div>filter: “{sub.filterQuery}”</div>}
                <div>
                  kinds:{' '}
                  {sub.allowedKinds && sub.allowedKinds.length > 0 ? (
                    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                      {sub.allowedKinds.map((k) => {
                        const accent = kindColors[k] ?? colors.dim;
                        return (
                          <span
                            key={k}
                            className="wm-chip"
                            style={{
                              background: `rgba(${rgb(accent)}, 0.15)`,
                              color: accent,
                            }}
                          >
                            {k}
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--wm-dim)' }}>all</span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="wm-btn wm-btn--danger" onClick={() => onDelete(sub)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
