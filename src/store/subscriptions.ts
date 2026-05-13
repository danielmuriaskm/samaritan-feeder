import { query, one, exec } from '../db.js';
import type { Subscription, DeliveryMode, EventKind } from '../types.js';

export async function listSubscriptions(opts?: {
  userId?: string;
  sourceId?: string;
  deliveryMode?: DeliveryMode;
}): Promise<Subscription[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts?.userId) { conditions.push(`user_id = $${idx++}`); params.push(opts.userId); }
  if (opts?.sourceId) { conditions.push(`source_id = $${idx++}`); params.push(opts.sourceId); }
  if (opts?.deliveryMode) { conditions.push(`delivery_mode = $${idx++}`); params.push(opts.deliveryMode); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM intelligence_subscriptions ${where} ORDER BY created_at DESC`,
    params,
  );
  return rows.map(fromRow);
}

export async function getSubscription(id: string): Promise<Subscription | undefined> {
  const row = await one<Record<string, unknown>>(
    `SELECT * FROM intelligence_subscriptions WHERE id = $1`,
    [id],
  );
  return row ? fromRow(row) : undefined;
}

export async function createSubscription(sub: Omit<Subscription, 'createdAt'>): Promise<Subscription> {
  const now = Date.now();
  await exec(
    `INSERT INTO intelligence_subscriptions
     (id, user_id, source_id, filter_query, min_confidence, allowed_kinds,
      delivery_mode, digest_cron, last_delivered_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      sub.id, sub.userId, sub.sourceId, sub.filterQuery ?? null, sub.minConfidence,
      sub.allowedKinds ?? null, sub.deliveryMode, sub.digestCron ?? null,
      sub.lastDeliveredAt ?? null, now,
    ],
  );
  return { ...sub, createdAt: now };
}

export async function deleteSubscription(id: string): Promise<void> {
  await exec(`DELETE FROM intelligence_subscriptions WHERE id = $1`, [id]);
}

export async function updateLastDelivered(id: string, timestamp: number): Promise<void> {
  await exec(
    `UPDATE intelligence_subscriptions SET last_delivered_at = $1 WHERE id = $2`,
    [timestamp, id],
  );
}

function fromRow(row: Record<string, unknown>): Subscription {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    sourceId: String(row.source_id),
    filterQuery: row.filter_query ? String(row.filter_query) : undefined,
    minConfidence: Number(row.min_confidence),
    allowedKinds: row.allowed_kinds ? (row.allowed_kinds as string[]) as EventKind[] : undefined,
    deliveryMode: row.delivery_mode as DeliveryMode,
    digestCron: row.digest_cron ? String(row.digest_cron) : undefined,
    lastDeliveredAt: row.last_delivered_at ? Number(row.last_delivered_at) : undefined,
    createdAt: Number(row.created_at),
  };
}
