import { useEffect, useState, type ReactNode } from 'react';
import { getBrief } from '../lib/api.js';
import type { Brief } from '../lib/types.js';

const signalKindColors: Record<string, string> = {
  convergence: '#3b82f6',
  geo_convergence: '#0ea5e9',
  velocity_spike: '#f59e0b',
  silent_source: '#6b7280',
  volume_anomaly: '#ef4444',
  cluster_surge: '#8b5cf6',
};

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
      <div style={{ padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 14, color: '#374151' }}>
        {String(item)}
      </div>
    );
  }

  const rec = asRecord(item);
  if (!rec) {
    // Array or other object shape — dump it readably.
    return (
      <div style={{ padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
        <pre style={{ margin: 0, fontSize: 12, color: '#6b7280', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
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
    <div style={{ padding: 14, borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: title || summary ? 8 : 0, flexWrap: 'wrap' }}>
        {kind && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              padding: '2px 8px',
              borderRadius: 4,
              background: signalKindColors[kind] ?? accent,
              color: '#fff',
            }}
          >
            {kind.replace(/_/g, ' ')}
          </span>
        )}
        {score !== undefined && (
          <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
            score {score.toFixed(score < 10 ? 2 : 0)}
          </span>
        )}
      </div>
      {title && <div style={{ fontWeight: 600, marginBottom: summary ? 4 : 0, color: '#111' }}>{title}</div>}
      {summary && <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.5 }}>{summary}</div>}
      {extras.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {extras.map(([k, v]) => (
            <span key={k} style={{ fontSize: 11, padding: '2px 8px', background: '#f3f4f6', borderRadius: 4, color: '#374151' }}>
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
      <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280', marginBottom: 10 }}>
        {title} <span style={{ color: '#9ca3af', fontWeight: 400 }}>({items.length})</span>
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
        <label style={{ fontSize: 13, color: '#6b7280' }}>Brief for</label>
        <input
          type="text"
          value={userIdInput}
          onChange={(e) => setUserIdInput(e.target.value)}
          placeholder="operator"
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, minWidth: 200 }}
        />
        <button
          type="submit"
          style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#f3f4f6', cursor: 'pointer', fontSize: 13 }}
        >
          Load
        </button>
        {brief && (
          <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
            {brief.eventCount.toLocaleString()} event{brief.eventCount === 1 ? '' : 's'} · {relativeTime(brief.createdAt)}
          </span>
        )}
      </form>

      {loading && <div style={{ fontSize: 13, color: '#666' }}>Loading...</div>}

      {!loading && error && (
        <div style={{ padding: 16, borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', fontSize: 14 }}>
          Failed to load brief: {error}
        </div>
      )}

      {!loading && !error && !brief && (
        <div
          style={{
            padding: 40,
            textAlign: 'center',
            color: '#6b7280',
            fontSize: 15,
            border: '1px dashed #e5e7eb',
            borderRadius: 8,
            background: '#fafafa',
          }}
        >
          📰 No brief yet — the digest cron synthesizes hourly.
        </div>
      )}

      {!loading && !error && brief && (
        <>
          {/* Lead */}
          <div
            style={{
              padding: 20,
              borderRadius: 8,
              border: '1px solid #e5e7eb',
              background: '#fff',
              marginBottom: 24,
            }}
          >
            <div style={{ fontSize: 17, lineHeight: 1.6, color: '#111', fontWeight: 500 }}>{brief.lead}</div>
            <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>{brief.eventCount.toLocaleString()} event{brief.eventCount === 1 ? '' : 's'}</span>
              {brief.windowStart !== undefined && brief.windowEnd !== undefined && (
                <span>
                  window {new Date(brief.windowStart).toLocaleString()} → {new Date(brief.windowEnd).toLocaleString()}
                </span>
              )}
              <span>synthesized {relativeTime(brief.createdAt)}</span>
            </div>
          </div>

          <Section title="Threads" items={threads} accent="#3b82f6" />
          <Section title="Signals" items={signals} accent="#8b5cf6" />

          {/* Ranked events */}
          {rankedEventIds.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280', marginBottom: 10 }}>
                Ranked events <span style={{ color: '#9ca3af', fontWeight: 400 }}>({rankedEventIds.length})</span>
              </div>
              <ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rankedEventIds.map((id, i) => (
                  <li key={`${id}-${i}`} style={{ fontSize: 13, color: '#374151' }}>
                    <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#6b7280' }}>{String(id)}</code>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {threads.length === 0 && signals.length === 0 && rankedEventIds.length === 0 && (
            <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>
              No threads, signals, or ranked events in this brief.
            </div>
          )}
        </>
      )}
    </div>
  );
}
