import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inQuietHours,
  formatPayload,
  payloadHash,
  planDelivery,
  deliverToChannels,
  senderFor,
  CHANNEL_SENDERS,
  type ChannelPayload,
} from './index.js';
import type { DeliveryChannel } from '../../types.js';

// Build a Date at a fixed local hour (host-local tz) for the tz-less path.
function atHour(h: number): Date {
  const d = new Date(2026, 5, 21, h, 30, 0); // 2026-06-21 h:30 local
  return d;
}

function channel(partial: Partial<DeliveryChannel> & Pick<DeliveryChannel, 'kind'>): DeliveryChannel {
  return {
    id: partial.id ?? `ch-${partial.kind}`,
    userId: partial.userId ?? 'u1',
    kind: partial.kind,
    config: partial.config ?? {},
    enabled: partial.enabled ?? true,
    quietHours: partial.quietHours,
    createdAt: partial.createdAt ?? 0,
  };
}

// ── inQuietHours ──────────────────────────────────────────────────────────────

test('inQuietHours: undefined window is never quiet', () => {
  assert.equal(inQuietHours(undefined, atHour(3)), false);
});

test('inQuietHours: same-day window [1,6) is half-open', () => {
  const qh = { startHour: 1, endHour: 6 };
  assert.equal(inQuietHours(qh, atHour(0)), false);
  assert.equal(inQuietHours(qh, atHour(1)), true); // start is inclusive
  assert.equal(inQuietHours(qh, atHour(5)), true);
  assert.equal(inQuietHours(qh, atHour(6)), false); // end is exclusive
  assert.equal(inQuietHours(qh, atHour(12)), false);
});

test('inQuietHours: wrap-around-midnight window [22,7)', () => {
  const qh = { startHour: 22, endHour: 7 };
  assert.equal(inQuietHours(qh, atHour(22)), true);
  assert.equal(inQuietHours(qh, atHour(23)), true);
  assert.equal(inQuietHours(qh, atHour(0)), true); // midnight
  assert.equal(inQuietHours(qh, atHour(6)), true);
  assert.equal(inQuietHours(qh, atHour(7)), false); // end exclusive
  assert.equal(inQuietHours(qh, atHour(12)), false);
  assert.equal(inQuietHours(qh, atHour(21)), false);
});

test('inQuietHours: equal start/end is an empty window (always delivering)', () => {
  const qh = { startHour: 9, endHour: 9 };
  for (let h = 0; h < 24; h++) assert.equal(inQuietHours(qh, atHour(h)), false);
});

test('inQuietHours: out-of-range hours are clamped, non-finite is ignored', () => {
  // start 25 -> 23, end -3 -> 0 ; 23 !== 0 so wrap window [23,0) = only hour 23.
  assert.equal(inQuietHours({ startHour: 25, endHour: -3 }, atHour(23)), true);
  assert.equal(inQuietHours({ startHour: 25, endHour: -3 }, atHour(0)), false);
  assert.equal(inQuietHours({ startHour: NaN, endHour: 5 }, atHour(2)), false);
});

test('inQuietHours: explicit tz is respected (UTC midnight window)', () => {
  // 2026-06-21T23:30:00Z -> hour 23 in UTC, inside [22,7).
  const utc2330 = new Date('2026-06-21T23:30:00Z');
  assert.equal(inQuietHours({ tz: 'UTC', startHour: 22, endHour: 7 }, utc2330), true);
  // Same instant, hour 12 in UTC -> outside.
  const utc1200 = new Date('2026-06-21T12:00:00Z');
  assert.equal(inQuietHours({ tz: 'UTC', startHour: 22, endHour: 7 }, utc1200), false);
});

test('inQuietHours: invalid tz falls back to host-local (does not throw)', () => {
  assert.doesNotThrow(() => inQuietHours({ tz: 'Not/AZone', startHour: 0, endHour: 24 }, atHour(3)));
});

// ── formatPayload ─────────────────────────────────────────────────────────────

test('formatPayload: title fallback uses kind, blank content is replaced', () => {
  const p = formatPayload({ content: '   ', kind: 'alert' });
  assert.equal(p.title, 'Intel: alert');
  assert.equal(p.content, '(no content)');
  assert.equal(p.url, undefined);
  assert.equal(p.mediaUrls, undefined);
});

test('formatPayload: trims/collapses whitespace and drops empty media/url', () => {
  const p = formatPayload({
    title: '  Quake  ',
    content: 'line\t\t  with   spaces\n\n\n\nbig gap',
    url: '',
    mediaUrls: ['', 'https://x/img.jpg', ''],
  });
  assert.equal(p.title, 'Quake');
  assert.equal(p.content, 'line with spaces\n\nbig gap');
  assert.equal(p.url, undefined);
  assert.deepEqual(p.mediaUrls, ['https://x/img.jpg']);
});

test('formatPayload: very long title is capped at 300 chars', () => {
  const p = formatPayload({ title: 'x'.repeat(500), content: 'c' });
  assert.equal(p.title.length, 300);
});

// ── payloadHash ───────────────────────────────────────────────────────────────

test('payloadHash: same title/content/url hash equal; media is ignored', () => {
  const a: ChannelPayload = { title: 't', content: 'c', url: 'u', mediaUrls: ['a'] };
  const b: ChannelPayload = { title: 't', content: 'c', url: 'u', mediaUrls: ['b'] };
  const c: ChannelPayload = { title: 't', content: 'DIFFERENT', url: 'u' };
  assert.equal(payloadHash(a), payloadHash(b));
  assert.notEqual(payloadHash(a), payloadHash(c));
});

// ── registry ──────────────────────────────────────────────────────────────────

test('registry: known kinds resolve, samaritan has no outbound sender', () => {
  for (const kind of ['telegram', 'discord', 'slack', 'webhook', 'email'] as const) {
    assert.equal(typeof CHANNEL_SENDERS[kind], 'function');
    assert.equal(typeof senderFor(kind), 'function');
  }
  assert.equal(senderFor('samaritan'), undefined);
});

// ── planDelivery (pure selection / dedup) ────────────────────────────────────

test('planDelivery: quiet-hours channel is suppressed, others send', () => {
  const now = atHour(3).getTime(); // 03:30 local
  const channels = [
    channel({ id: 'a', kind: 'telegram' }),
    channel({ id: 'b', kind: 'slack', quietHours: { startHour: 1, endHour: 6 } }),
  ];
  const payload = formatPayload({ title: 'T', content: 'C' });
  const plan = planDelivery(channels, payload, { now, dedupWindowMs: 1000, seen: new Map() });
  assert.equal(plan.find((p) => p.channel.id === 'a')!.action, 'send');
  assert.equal(plan.find((p) => p.channel.id === 'b')!.action, 'quiet_hours');
});

test('planDelivery: a recent identical send is deduped within the window', () => {
  const now = 1_000_000;
  const channels = [channel({ id: 'a', kind: 'telegram' })];
  const payload = formatPayload({ title: 'T', content: 'C' });
  const seen = new Map<string, number>();
  const first = planDelivery(channels, payload, { now, dedupWindowMs: 5000, seen });
  assert.equal(first[0].action, 'send');
  // Simulate the successful send recording its key.
  seen.set(first[0].dedupKey, now);
  const within = planDelivery(channels, payload, { now: now + 4000, dedupWindowMs: 5000, seen });
  assert.equal(within[0].action, 'dedup');
  const after = planDelivery(channels, payload, { now: now + 6000, dedupWindowMs: 5000, seen });
  assert.equal(after[0].action, 'send'); // window elapsed
});

test('planDelivery: samaritan and unknown kinds are unsupported (router fallback territory)', () => {
  const channels = [channel({ id: 's', kind: 'samaritan' })];
  const payload = formatPayload({ title: 'T', content: 'C' });
  const plan = planDelivery(channels, payload, { now: 0, dedupWindowMs: 1000, seen: new Map() });
  assert.equal(plan[0].action, 'unsupported');
});

// ── deliverToChannels (mocked sender, no network) ────────────────────────────

test('deliverToChannels: fans out to enabled channels via injected sender', async () => {
  const calls: string[] = [];
  const channels = [
    channel({ id: 'a', kind: 'telegram' }),
    channel({ id: 'b', kind: 'discord' }),
    channel({ id: 'c', kind: 'slack', quietHours: { startHour: 0, endHour: 24 } }), // always quiet -> [0,23]
  ];
  const res = await deliverToChannels(
    'u1',
    { title: 'Hi', content: 'Body' },
    {
      channels,
      now: atHour(12).getTime(),
      sender: async (kind) => {
        calls.push(kind);
        return { ok: true };
      },
    },
  );
  assert.equal(res.total, 3);
  assert.equal(res.delivered, 2);
  assert.deepEqual(calls.sort(), ['discord', 'telegram']);
  const slack = res.outcomes.find((o) => o.kind === 'slack')!;
  assert.equal(slack.status, 'suppressed');
});

test('deliverToChannels: a failing channel does not block the others', async () => {
  const channels = [
    channel({ id: 'a', kind: 'telegram' }),
    channel({ id: 'b', kind: 'webhook' }),
  ];
  const res = await deliverToChannels(
    'u1',
    { content: 'Body only' },
    {
      channels,
      sender: async (kind) => (kind === 'telegram' ? { ok: false, error: 'boom' } : { ok: true }),
    },
  );
  assert.equal(res.delivered, 1);
  const tg = res.outcomes.find((o) => o.kind === 'telegram')!;
  assert.equal(tg.status, 'failed');
  assert.equal(tg.status === 'failed' && tg.error, 'boom');
});

test('deliverToChannels: a thrown sender is captured as a failure', async () => {
  const channels = [channel({ id: 'a', kind: 'telegram' })];
  const res = await deliverToChannels(
    'u1',
    { content: 'x' },
    {
      channels,
      sender: async () => {
        throw new Error('network down');
      },
    },
  );
  assert.equal(res.delivered, 0);
  assert.equal(res.outcomes[0].status, 'failed');
});
