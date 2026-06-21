/**
 * Store for per-user delivery channels (005, multi-channel fan-out).
 *
 * CRUD over `delivery_channels`. The `quiet_hours` column is a JSONB blob of the
 * `DeliveryChannel['quietHours']` shape ({ tz?, startHour, endHour }). The
 * delivery registry (src/delivery/channels/index.ts) reads these to fan a single
 * payload out to every enabled channel a user has configured.
 */

import { query, one, exec } from '../db.js';
import type { DeliveryChannel, ChannelKind } from '../types.js';
import { randomUUID } from 'crypto';

const VALID_KINDS: ReadonlyArray<ChannelKind> = [
  'telegram',
  'discord',
  'slack',
  'webhook',
  'email',
  'samaritan',
];

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === 'string' && (VALID_KINDS as readonly string[]).includes(value);
}

/** All channels for a user. `enabledOnly` filters to active channels (the delivery path). */
export async function listChannels(userId: string, enabledOnly = false): Promise<DeliveryChannel[]> {
  const where = enabledOnly ? 'WHERE user_id = $1 AND enabled' : 'WHERE user_id = $1';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM delivery_channels ${where} ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(fromRow);
}

export async function getChannel(id: string): Promise<DeliveryChannel | undefined> {
  const row = await one<Record<string, unknown>>(
    `SELECT * FROM delivery_channels WHERE id = $1`,
    [id],
  );
  return row ? fromRow(row) : undefined;
}

export async function createChannel(
  ch: Omit<DeliveryChannel, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<DeliveryChannel> {
  const id = ch.id ?? randomUUID();
  const createdAt = ch.createdAt ?? Date.now();
  const enabled = ch.enabled ?? true;
  await exec(
    `INSERT INTO delivery_channels (id, user_id, kind, config, enabled, quiet_hours, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      ch.userId,
      ch.kind,
      JSON.stringify(ch.config ?? {}),
      enabled,
      ch.quietHours ? JSON.stringify(ch.quietHours) : null,
      createdAt,
    ],
  );
  return { ...ch, id, enabled, createdAt };
}

export async function deleteChannel(id: string): Promise<void> {
  await exec(`DELETE FROM delivery_channels WHERE id = $1`, [id]);
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await exec(`UPDATE delivery_channels SET enabled = $1 WHERE id = $2`, [enabled, id]);
}

function fromRow(row: Record<string, unknown>): DeliveryChannel {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind as ChannelKind,
    config: parseJson(row.config) ?? {},
    enabled: Boolean(row.enabled),
    quietHours: parseQuietHours(row.quiet_hours),
    createdAt: Number(row.created_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return value as Record<string, unknown>;
}

function parseQuietHours(value: unknown): DeliveryChannel['quietHours'] {
  const obj = parseJson(value);
  if (!obj) return undefined;
  if (typeof obj.startHour !== 'number' || typeof obj.endHour !== 'number') return undefined;
  return {
    tz: typeof obj.tz === 'string' ? obj.tz : undefined,
    startHour: obj.startHour,
    endHour: obj.endHour,
  };
}
