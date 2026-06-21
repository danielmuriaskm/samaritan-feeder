/**
 * Generic webhook channel — POST the payload as JSON to an arbitrary URL.
 * config: { url: string; headers?: Record<string, string> }
 *
 * The whole payload is sent as a structured JSON body so the receiver can render
 * it however it likes. `config.headers` lets the operator attach an auth token,
 * signature header, etc. (string values only).
 */

import { safeFetch } from '../../util/safeFetch.js';
import type { ChannelPayload, SendResult } from './index.js';

export async function send(config: Record<string, unknown>, payload: ChannelPayload): Promise<SendResult> {
  const url = typeof config.url === 'string' ? config.url : '';
  if (!url) return { ok: false, error: 'webhook channel missing url' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.headers && typeof config.headers === 'object') {
    for (const [k, v] of Object.entries(config.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }

  const body = {
    title: payload.title,
    content: payload.content,
    url: payload.url,
    mediaUrls: payload.mediaUrls ?? [],
    sentAt: Date.now(),
  };

  try {
    const res = await safeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 10000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `webhook ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
