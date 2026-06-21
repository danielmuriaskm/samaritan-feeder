/**
 * Slack channel — POST to an incoming webhook.
 * config: { webhookUrl: string }
 */

import { safeFetch } from '../../util/safeFetch.js';
import type { ChannelPayload, SendResult } from './index.js';

export async function send(config: Record<string, unknown>, payload: ChannelPayload): Promise<SendResult> {
  const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl : '';
  if (!webhookUrl) return { ok: false, error: 'slack channel missing webhookUrl' };

  // Block Kit: a header + a section. Slack incoming webhooks also accept `text`
  // as a fallback for notifications/screen readers.
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: truncate(payload.title, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(payload.content, 3000) } },
  ];
  if (payload.url) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${payload.url}|source>` }],
    });
  }

  try {
    const res = await safeFetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload.title, blocks }),
      timeoutMs: 10000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `slack ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
