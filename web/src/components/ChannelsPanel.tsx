import { useEffect, useState } from 'react';
import { listChannels, createChannel, setChannelEnabled, deleteChannel } from '../lib/api.js';
import type { Channel, ChannelKind } from '../lib/types.js';
import { colors, channelColors, rgb } from '../lib/theme.js';

const USER_ID = 'operator';

const kindIcons: Record<ChannelKind, string> = {
  telegram: '✈️',
  discord: '🎮',
  slack: '💬',
  webhook: '🪝',
  email: '📧',
  samaritan: '🧠',
};

// Kinds the operator can add from the console (samaritan is system-managed).
const ADDABLE_KINDS: ChannelKind[] = ['telegram', 'discord', 'slack', 'webhook', 'email'];

// Per-kind config field schema. `secret` fields are masked in the summary.
interface Field {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
}

const FIELDS: Record<ChannelKind, Field[]> = {
  telegram: [
    { key: 'botToken', label: 'Bot token', placeholder: '123456:ABC-DEF...', secret: true },
    { key: 'chatId', label: 'Chat ID', placeholder: '-1001234567890' },
  ],
  discord: [{ key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/...', secret: true }],
  slack: [{ key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/...', secret: true }],
  webhook: [{ key: 'url', label: 'URL', placeholder: 'https://example.com/hook' }],
  email: [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://api.mail-provider.com/send' },
    { key: 'apiKey', label: 'API key', placeholder: 'sk-...', secret: true },
    { key: 'to', label: 'To', placeholder: 'ops@example.com' },
  ],
  samaritan: [],
};

// Show only the last 4 chars of a secret value; leave non-secret values readable but capped.
function mask(value: unknown, secret: boolean | undefined): string {
  const s = String(value ?? '');
  if (!s) return '∅';
  if (secret) {
    const tail = s.slice(-4);
    return s.length <= 4 ? '••••' : `••••${tail}`;
  }
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function configSummary(kind: ChannelKind, config: Record<string, unknown>): string {
  const fields = FIELDS[kind] ?? [];
  if (fields.length === 0) {
    // Unknown / system kind: mask everything defensively.
    return Object.entries(config)
      .map(([k, v]) => `${k}: ${mask(v, true)}`)
      .join('  •  ');
  }
  return fields.map((f) => `${f.label}: ${mask(config[f.key], f.secret)}`).join('  •  ');
}

export default function ChannelsPanel() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<ChannelKind>('telegram');
  const [form, setForm] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const list = await listChannels(USER_ID);
      setChannels(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load channels');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const fields = FIELDS[kind];
  const canSubmit = fields.length > 0 && fields.every((f) => (form[f.key] ?? '').trim().length > 0);

  function onKindChange(next: ChannelKind) {
    setKind(next);
    setForm({});
  }

  async function onAdd() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const config: Record<string, unknown> = {};
      for (const f of fields) config[f.key] = form[f.key].trim();
      await createChannel({ userId: USER_ID, kind, config });
      setForm({});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create channel');
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggle(ch: Channel) {
    setBusyId(ch.id);
    setError(null);
    try {
      await setChannelEnabled(ch.id, !ch.enabled);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update channel');
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(ch: Channel) {
    if (!window.confirm(`Delete this ${ch.kind} channel? This cannot be undone.`)) return;
    setBusyId(ch.id);
    setError(null);
    try {
      await deleteChannel(ch.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete channel');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 760, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Add channel form */}
      <div className="wm-card" style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Add delivery channel</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>Kind</span>
            <select
              className="wm-select"
              value={kind}
              onChange={(e) => onKindChange(e.target.value as ChannelKind)}
            >
              {ADDABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindIcons[k]} {k}
                </option>
              ))}
            </select>
          </label>

          {fields.map((f) => (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>{f.label}</span>
              <input
                className="wm-input"
                type={f.secret ? 'password' : 'text'}
                value={form[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </label>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className="wm-btn wm-btn--primary"
              onClick={onAdd}
              disabled={!canSubmit || submitting}
            >
              {submitting ? 'Adding…' : 'Add channel'}
            </button>
            <span style={{ fontSize: 12, color: 'var(--wm-muted)' }}>Secrets are stored by the feeder and never shown again.</span>
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
        {loading ? 'Loading…' : `${channels.length} channel${channels.length === 1 ? '' : 's'}`}
      </div>

      {/* Channel list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!loading && channels.length === 0 && (
          <div style={{ fontSize: 14, color: 'var(--wm-muted)', textAlign: 'center', padding: 24 }}>
            No channels yet. Add one above to receive briefs and alerts.
          </div>
        )}
        {channels.map((ch) => {
          const busy = busyId === ch.id;
          return (
            <div
              key={ch.id}
              className="wm-card"
              style={{
                padding: 16,
                opacity: ch.enabled ? 1 : 0.7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span
                  className="wm-chip"
                  style={{ background: channelColors[ch.kind] ?? colors.dim }}
                >
                  {kindIcons[ch.kind] ?? '📡'} {ch.kind}
                </span>
                <span
                  className="wm-chip"
                  style={{
                    background: ch.enabled ? `rgba(${rgb(colors.live)}, 0.15)` : `rgba(${rgb(colors.muted)}, 0.15)`,
                    color: ch.enabled ? colors.live : colors.dim,
                  }}
                >
                  {ch.enabled ? 'Enabled' : 'Disabled'}
                </span>
                {ch.quietHours && (
                  <span style={{ fontSize: 12, color: 'var(--wm-dim)' }}>
                    🌙 quiet {ch.quietHours.startHour}:00–{ch.quietHours.endHour}:00
                    {ch.quietHours.tz ? ` ${ch.quietHours.tz}` : ''}
                  </span>
                )}
                <span style={{ fontSize: 12, color: 'var(--wm-dim)', marginLeft: 'auto' }}>
                  {new Date(ch.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div className="wm-meta" style={{ fontSize: 13, color: 'var(--wm-text-2)', wordBreak: 'break-all', marginBottom: 12 }}>
                {configSummary(ch.kind, ch.config)}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="wm-btn"
                  onClick={() => onToggle(ch)}
                  disabled={busy}
                >
                  {ch.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="wm-btn wm-btn--danger"
                  onClick={() => onDelete(ch)}
                  disabled={busy}
                >
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
