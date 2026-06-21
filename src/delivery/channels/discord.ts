/**
 * Discord channel — POST to an incoming webhook.
 * config: { webhookUrl: string; username?: string }
 */

import { safeFetch } from '../../util/safeFetch.js';
import type { ChannelPayload, SendResult } from './index.js';

export async function send(config: Record<string, unknown>, payload: ChannelPayload): Promise<SendResult> {
  const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl : '';
  if (!webhookUrl) return { ok: false, error: 'discord channel missing webhookUrl' };

  // Discord renders an "embed" nicely; fall back to plain content for the body.
  const embed: Record<string, unknown> = {
    title: truncate(payload.title, 256),
    description: truncate(payload.content, 4096),
  };
  if (payload.url) embed.url = payload.url;
  if (payload.mediaUrls && payload.mediaUrls.length > 0) {
    embed.image = { url: payload.mediaUrls[0] };
  }

  const body: Record<string, unknown> = { embeds: [embed] };
  if (typeof config.username === 'string') body.username = config.username;

  try {
    const res = await safeFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 10000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `discord ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
