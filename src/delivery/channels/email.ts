/**
 * Email channel — relays through a configured HTTP email API (no SMTP, no new
 * npm dependency). The operator points this at any transactional-email provider
 * that accepts a JSON POST (e.g. a generic /send endpoint).
 *
 * config: {
 *   endpoint: string;          // HTTPS POST target
 *   apiKey?: string;           // sent as Authorization: Bearer <apiKey>
 *   to: string;                // recipient address
 *   from?: string;             // sender address (provider default if omitted)
 *   apiKeyHeader?: string;     // override the auth header name (default Authorization)
 * }
 *
 * If endpoint/to are missing, returns {ok:false, error:'email channel not configured'}
 * — the registry treats that as a skipped channel, not a hard failure.
 */

import { safeFetch } from '../../util/safeFetch.js';
import type { ChannelPayload, SendResult } from './index.js';

export async function send(config: Record<string, unknown>, payload: ChannelPayload): Promise<SendResult> {
  const endpoint = typeof config.endpoint === 'string' ? config.endpoint : '';
  const to = typeof config.to === 'string' ? config.to : '';
  if (!endpoint || !to) {
    return { ok: false, error: 'email channel not configured' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof config.apiKey === 'string' && config.apiKey) {
    const headerName = typeof config.apiKeyHeader === 'string' ? config.apiKeyHeader : 'Authorization';
    headers[headerName] =
      headerName.toLowerCase() === 'authorization' ? `Bearer ${config.apiKey}` : config.apiKey;
  }

  const body: Record<string, unknown> = {
    to,
    subject: payload.title,
    text: renderText(payload),
    html: renderHtml(payload),
  };
  if (typeof config.from === 'string') body.from = config.from;

  try {
    const res = await safeFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 15000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `email ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function renderText(payload: ChannelPayload): string {
  const parts = [payload.title, '', payload.content];
  if (payload.url) parts.push('', payload.url);
  return parts.join('\n');
}

function renderHtml(payload: ChannelPayload): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [`<h2>${esc(payload.title)}</h2>`, `<p>${esc(payload.content)}</p>`];
  if (payload.url) lines.push(`<p><a href="${esc(payload.url)}">${esc(payload.url)}</a></p>`);
  return lines.join('\n');
}
