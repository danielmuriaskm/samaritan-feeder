import { useEffect, useState, type ReactNode } from 'react';
import { getEvents, getSignals, getSources, getBrief } from '../lib/api.js';
import { useEventStream } from '../lib/useSSE.js';
import { colors, kindColors, signalColors, healthColors, scoreColor } from '../lib/theme.js';
import type { IntelEvent, IntelSignal, Source, Brief } from '../lib/types.js';

// worldmonitor-style situational-awareness overview: a dense grid of compact panels,
// composed entirely from the existing API client + the live SSE spine. No server work.

function rel(ts: number): string {
  const d = Date.now() - ts;
  if (d < 0) return 'now';
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function Panel({ title, count, span, children }: { title: string; count?: number; span?: number; children: ReactNode }) {
  return (
    <div className="wm-panel" style={{ gridColumn: span ? `span ${span}` : undefined, maxHeight: 340 }}>
      <div className="wm-panel__head">
        <span>{title}</span>
        {count != null && <span className="wm-panel__count">{count}</span>}
      </div>
      <div className="wm-panel__body">{children}</div>
    </div>
  );
}

function Chip({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span className="wm-chip" style={{ background: color }} title={title}>
      {label}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ color: colors.muted, fontSize: 12, padding: '8px 0' }}>{text}</div>;
}

function EventRow({ e }: { e: IntelEvent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <Chip label={e.kind} color={kindColors[e.kind] ?? colors.dim} />
      <span style={{ flex: 1, fontSize: 13, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {e.title ?? e.content.slice(0, 80)}
      </span>
      {e.score != null && (
        <span className="wm-chip" style={{ background: scoreColor(e.score) }}>
          {(e.score * 100).toFixed(0)}
        </span>
      )}
      <span className="wm-meta" style={{ minWidth: 28, textAlign: 'right' }}>{rel(e.eventAt)}</span>
    </div>
  );
}

function SignalRow({ s }: { s: IntelSignal }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: `1px solid ${colors.borderSubtle}` }}>
      <Chip label={s.kind.replace(/_/g, ' ')} color={signalColors[s.kind] ?? colors.dim} />
      <span style={{ flex: 1, fontSize: 13, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {s.title}
      </span>
      <span className="wm-chip" style={{ background: scoreColor(s.score > 1 ? s.score / 100 : s.score) }}>
        {s.score < 10 ? s.score.toFixed(1) : s.score.toFixed(0)}
      </span>
      <span className="wm-meta" style={{ minWidth: 28, textAlign: 'right' }}>{rel(s.createdAt)}</span>
    </div>
  );
}

export default function Overview() {
  const live = useEventStream('operator', { max: 40 });
  const [topEvents, setTopEvents] = useState<IntelEvent[]>([]);
  const [recent, setRecent] = useState<IntelEvent[]>([]);
  const [signals, setSignals] = useState<IntelSignal[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getEvents({ rank: 'score', limit: 8 }).then((d) => alive && setTopEvents(d)).catch(() => {});
      getEvents({ rank: 'recency', limit: 40 }).then((d) => alive && setRecent(d)).catch(() => {});
      getSignals({ limit: 20 }).then((d) => alive && setSignals(d)).catch(() => {});
      getSources().then((d) => alive && setSources(d)).catch(() => {});
      getBrief('operator').then((d) => alive && setBrief(d)).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Live ticker prefers the SSE buffer; falls back to the last recency fetch.
  const ticker = live.events.length ? live.events : recent;

  // Source-health summary.
  const byState: Record<string, number> = {};
  for (const s of sources) {
    const st = s.healthState ?? (s.enabled ? 'healthy' : 'silent');
    byState[st] = (byState[st] ?? 0) + 1;
  }
  const unhealthy = sources.filter((s) => s.healthState && s.healthState !== 'healthy');

  // Event-mix breakdown (last recency fetch).
  const kindCounts: Record<string, number> = {};
  for (const e of recent) kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
  const kindEntries = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  const kindMax = Math.max(1, ...kindEntries.map(([, n]) => n));

  return (
    <div className="wm-grid" style={{ overflowY: 'auto', height: '100%' }}>
      {/* Current brief — wide */}
      <Panel title="Current Brief" span={2}>
        {brief ? (
          <div>
            <div style={{ fontSize: 15, lineHeight: 1.5, color: colors.text, fontWeight: 500 }}>{brief.lead}</div>
            <div className="wm-meta" style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>{brief.eventCount.toLocaleString()} events</span>
              <span>synthesized {rel(brief.createdAt)} ago</span>
              {brief.body?.rankedEventIds?.length ? <span>{brief.body.rankedEventIds.length} ranked</span> : null}
            </div>
          </div>
        ) : (
          <Empty text="No brief yet — the digest cron synthesizes hourly." />
        )}
      </Panel>

      {/* Live feed */}
      <Panel title="Live Feed" count={ticker.length}>
        {ticker.length ? ticker.slice(0, 20).map((e) => <EventRow key={e.id} e={e} />) : <Empty text="Waiting for live events…" />}
      </Panel>

      {/* Top scored events */}
      <Panel title="Top Events" count={topEvents.length}>
        {topEvents.length ? topEvents.map((e) => <EventRow key={e.id} e={e} />) : <Empty text="No scored events yet." />}
      </Panel>

      {/* Active signals */}
      <Panel title="Active Signals" count={signals.length}>
        {signals.length ? signals.slice(0, 16).map((s) => <SignalRow key={s.id} s={s} />) : <Empty text="No signals in window." />}
      </Panel>

      {/* Source health */}
      <Panel title="Source Health" count={sources.length}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {(['healthy', 'degraded', 'silent', 'failing', 'cooldown'] as const).map((st) =>
            byState[st] ? <Chip key={st} label={`${byState[st]} ${st}`} color={healthColors[st]} /> : null,
          )}
          {!sources.length && <Empty text="No sources." />}
        </div>
        {unhealthy.slice(0, 8).map((s) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <span className="wm-dot wm-dot--glow" style={{ background: healthColors[s.healthState ?? 'failing'], color: healthColors[s.healthState ?? 'failing'] }} />
            <span style={{ flex: 1, fontSize: 12, color: colors.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <span className="wm-meta">{s.healthState}</span>
          </div>
        ))}
      </Panel>

      {/* Event mix */}
      <Panel title="Event Mix" count={recent.length}>
        {kindEntries.length ? (
          kindEntries.map(([k, n]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <span style={{ width: 78, fontSize: 12, color: colors.text2 }}>{k}</span>
              <div style={{ flex: 1, height: 8, background: colors.hover, borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${(n / kindMax) * 100}%`, height: '100%', background: kindColors[k] ?? colors.dim }} />
              </div>
              <span className="wm-meta" style={{ minWidth: 24, textAlign: 'right' }}>{n}</span>
            </div>
          ))
        ) : (
          <Empty text="No recent events." />
        )}
      </Panel>
    </div>
  );
}
