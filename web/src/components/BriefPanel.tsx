import { useEffect, useState, type ReactNode } from 'react';
import { getBrief, getEvent } from '../lib/api.js';
import type { Brief } from '../lib/types.js';
import { signalColors, colors, rgb, fonts } from '../lib/theme.js';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

// body.threads / body.signals arrive as unknown[]; render whatever shape shows up.
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function ItemCard({ item, accent }: { item: unknown; accent: string }): ReactNode {
  // Primitive item -> just print it.
  if (item === null || typeof item !== 'object') {
    return (
      <div className="wm-card" style={{ padding: 12, fontSize: 14, color: 'var(--wm-text-2)' }}>
        {String(item)}
      </div>
    );
  }

  const rec = asRecord(item);
  if (!rec) {
    // Array or other object shape — dump it readably.
    return (
      <div className="wm-card" style={{ padding: 12 }}>
        <pre style={{ margin: 0, fontSize: 12, color: 'var(--wm-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(item, null, 2)}
        </pre>
      </div>
    );
  }

  const title = firstString(rec, ['title', 'name', 'label', 'lead', 'headline']);
  const summary = firstString(rec, ['summary', 'description', 'body', 'text', 'content']);
  const kind = firstString(rec, ['kind', 'type', 'category']);
  const scoreVal = rec.score;
  const score = typeof scoreVal === 'number' ? scoreVal : undefined;

  // Keys we've already surfaced — everything else becomes a meta chip.
  const shown = new Set(['title', 'name', 'label', 'lead', 'headline', 'summary', 'description', 'body', 'text', 'content', 'kind', 'type', 'category', 'score']);
  const extras = Object.entries(rec).filter(
    ([k, v]) => !shown.has(k) && v !== null && v !== undefined && typeof v !== 'object'
  );

  return (
    <div className="wm-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: title || summary ? 8 : 0, flexWrap: 'wrap' }}>
        {kind && (
          <span
            className="wm-chip"
            style={{
              textTransform: 'uppercase',
              color: signalColors[kind] ?? accent,
              borderColor: signalColors[kind] ?? accent,
            }}
          >
            {kind.replace(/_/g, ' ')}
          </span>
        )}
        {score !== undefined && (
          <span className="wm-meta" style={{ fontSize: 12, color: 'var(--wm-dim)', marginLeft: 'auto' }}>
            score {score.toFixed(score < 10 ? 2 : 0)}
          </span>
        )}
      </div>
      {title && <div style={{ fontWeight: 600, marginBottom: summary ? 4 : 0, color: 'var(--wm-text)' }}>{title}</div>}
      {summary && <div style={{ fontSize: 14, color: 'var(--wm-text-2)', lineHeight: 1.5 }}>{summary}</div>}
      {extras.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {extras.map(([k, v]) => (
            <span key={k} className="wm-chip wm-meta">
              {k}: {String(v).slice(0, 40)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, items, accent }: { title: string; items: unknown[]; accent: string }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--wm-dim)', marginBottom: 10 }}>
        {title} <span style={{ color: 'var(--wm-muted)', fontWeight: 400 }}>({items.length})</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item, i) => (
          <ItemCard key={i} item={item} accent={accent} />
        ))}
      </div>
    </div>
  );
}

export default function BriefPanel() {
  const [userIdInput, setUserIdInput] = useState('operator');
  const [userId, setUserId] = useState('operator');
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Resolve the brief's ranked event ids -> titles so the list isn't raw UUIDs.
  const [eventTitles, setEventTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBrief(userId)
      .then((b) => {
        if (!cancelled) {
          setBrief(b);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Hydrate ranked-event ids -> titles (best-effort; raw id is the fallback).
  useEffect(() => {
    const ids = (brief?.body?.rankedEventIds ?? []).map(String);
    if (ids.length === 0) {
      setEventTitles({});
      return;
    }
    let cancelled = false;
    Promise.all(
      ids.slice(0, 50).map(async (id) => {
        try {
          const ev = await getEvent(id);
          const label = ev?.title || ev?.content?.slice(0, 90) || '';
          return [id, label] as const;
        } catch {
          return [id, ''] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setEventTitles(Object.fromEntries(pairs.filter(([, t]) => t)));
    });
    return () => {
      cancelled = true;
    };
  }, [brief]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setUserId(userIdInput.trim() || 'operator');
  };

  const threads = brief?.body?.threads ?? [];
  const signals = brief?.body?.signals ?? [];
  const rankedEventIds = brief?.body?.rankedEventIds ?? [];

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* User selector */}
      <form onSubmit={submit} style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: 'var(--wm-dim)' }}>Brief for</label>
        <input
          type="text"
          className="wm-input"
          value={userIdInput}
          onChange={(e) => setUserIdInput(e.target.value)}
          placeholder="operator"
          style={{ minWidth: 200 }}
        />
        <button
          type="submit"
          className="wm-btn"
          style={{ cursor: 'pointer' }}
        >
          Load
        </button>
        {brief && (
          <span className="wm-meta" style={{ fontSize: 12, color: 'var(--wm-dim)', marginLeft: 'auto' }}>
            {brief.eventCount.toLocaleString()} event{brief.eventCount === 1 ? '' : 's'} · {relativeTime(brief.createdAt)}
          </span>
        )}
      </form>

      {loading && <div style={{ fontSize: 13, color: 'var(--wm-dim)' }}>Loading...</div>}

      {!loading && error && (
        <div style={{ padding: 16, borderRadius: 4, color: 'var(--wm-critical)', background: `rgba(${rgb(colors.critical)}, 0.10)`, fontSize: 14 }}>
          Failed to load brief: {error}
        </div>
      )}

      {!loading && !error && !brief && (
        <div
          className="wm-card"
          style={{
            padding: 40,
            textAlign: 'center',
            color: 'var(--wm-dim)',
            fontSize: 15,
          }}
        >
          📰 No brief yet — the digest cron synthesizes hourly.
        </div>
      )}

      {!loading && !error && brief && (
        <>
          {/* Lead */}
          <div
            className="wm-card"
            style={{
              padding: 20,
              marginBottom: 24,
            }}
          >
            <div style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--wm-text)', fontWeight: 500 }}>{brief.lead}</div>
            <div className="wm-meta" style={{ marginTop: 12, fontSize: 12, color: 'var(--wm-dim)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>{brief.eventCount.toLocaleString()} event{brief.eventCount === 1 ? '' : 's'}</span>
              {brief.windowStart !== undefined && brief.windowEnd !== undefined && (
                <span>
                  window {new Date(brief.windowStart).toLocaleString()} → {new Date(brief.windowEnd).toLocaleString()}
                </span>
              )}
              <span>synthesized {relativeTime(brief.createdAt)}</span>
            </div>
          </div>

          <Section title="Threads" items={threads} accent={colors.info} />
          <Section title="Signals" items={signals} accent={colors.purple} />

          {/* Ranked events */}
          {rankedEventIds.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--wm-dim)', marginBottom: 10 }}>
                Ranked events <span style={{ color: 'var(--wm-muted)', fontWeight: 400 }}>({rankedEventIds.length})</span>
              </div>
              <ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rankedEventIds.map((id, i) => {
                  const title = eventTitles[String(id)];
                  return (
                    <li key={`${id}-${i}`} style={{ fontSize: 13, color: 'var(--wm-text-2)' }}>
                      {title ? (
                        <span>{title}</span>
                      ) : (
                        <code style={{ fontFamily: fonts.mono, fontSize: 12, color: 'var(--wm-dim)' }}>{String(id)}</code>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {threads.length === 0 && signals.length === 0 && rankedEventIds.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--wm-muted)', fontStyle: 'italic' }}>
              No threads, signals, or ranked events in this brief.
            </div>
          )}
        </>
      )}
    </div>
  );
}
