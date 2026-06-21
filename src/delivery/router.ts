/**
 * Delivery router for intelligence events.
 * Routes processed events to subscribers based on filters and delivery modes.
 */

import { listSubscriptions, updateLastDelivered } from '../store/subscriptions.js';
import type { IntelligenceEvent, Subscription } from '../types.js';
import { pushAlertToSamaritan } from '../samaritan-client.js';
import { deliverToChannels } from './channels/index.js';
import { randomUUID } from 'crypto';

export async function routeEventToSubscribers(event: IntelligenceEvent): Promise<void> {
  const subs = await listSubscriptions({ sourceId: event.sourceId });

  for (const sub of subs) {
    if (!shouldDeliver(event, sub)) continue;

    try {
      await deliverEvent(event, sub);
    } catch (err) {
      console.error(`[delivery] Failed to deliver ${event.id} to ${sub.userId}:`, err);
    }
  }
}

function shouldDeliver(event: IntelligenceEvent, sub: Subscription): boolean {
  // Confidence threshold
  if (event.confidence < sub.minConfidence) return false;

  // Kind filter
  if (sub.allowedKinds && !sub.allowedKinds.includes(event.kind)) return false;

  // Semantic filter (simple keyword match for now)
  if (sub.filterQuery) {
    const query = sub.filterQuery.toLowerCase();
    const text = `${event.title ?? ''} ${event.content}`.toLowerCase();
    if (!text.includes(query)) return false;
  }

  return true;
}

async function deliverEvent(event: IntelligenceEvent, sub: Subscription): Promise<void> {
  const now = Date.now();

  switch (sub.deliveryMode) {
    case 'alert':
    case 'proactive': {
      // Fan out to the user's configured channels (telegram/discord/slack/webhook/email),
      // falling back to the built-in Samaritan push when the user has none configured.
      const payload = {
        title: event.title ?? `Intel ${event.kind}`,
        content: event.content,
        mediaUrls: event.mediaUrls,
        kind: event.kind,
      };
      const res = await deliverToChannels(sub.userId, payload);
      if (res.total === 0) {
        await pushAlertToSamaritan({
          userId: sub.userId,
          title: payload.title,
          content: payload.content,
          mediaUrls: payload.mediaUrls,
        });
      }
      break;
    }
    case 'passive':
    default:
      // Passive: just store, no push
      break;
  }

  await updateLastDelivered(sub.id, now);

  // Log delivery
  const { exec } = await import('../db.js');
  await exec(
    `INSERT INTO intelligence_deliveries (id, event_id, user_id, delivery_mode, channel, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), event.id, sub.userId, sub.deliveryMode, 'samaritan', 'delivered', now],
  );
}
