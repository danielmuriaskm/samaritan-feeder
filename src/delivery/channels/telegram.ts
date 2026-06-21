/**
 * Telegram channel — POST to the Bot API `sendMessage`.
 * config: { botToken: string; chatId: string | number; parseMode?: 'Markdown' | 'HTML' }
 */

import { safeFetch } from '../../util/safeFetch.js';
import type { ChannelPayload, SendResult } from './index.js';

export async function send(config: Record<string, unknown>, payload: ChannelPayload): Promise<SendResult> {
  const botToken = typeof config.botToken === 'string' ? config.botToken : '';
  const chatId = config.chatId;
  if (!botToken || (typeof chatId !== 'string' && typeof chatId !== 'number')) {
    return { ok: false, error: 'telegram channel missing botToken/chatId' };
  }

  const parseMode = config.parseMode === 'HTML' ? 'HTML' : 'Markdown';
  const text = renderText(payload, parseMode);

  try {
    const res = await safeFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      }),
      timeoutMs: 10000,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `telegram ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function renderText(payload: ChannelPayload, parseMode: 'Markdown' | 'HTML'): string {
  const parts: string[] = [];
  if (parseMode === 'HTML') {
    parts.push(`<b>${escapeHtml(payload.title)}</b>`);
    parts.push(escapeHtml(payload.content));
    if (payload.url) parts.push(escapeHtml(payload.url));
  } else {
    parts.push(`*${payload.title}*`);
    parts.push(payload.content);
    if (payload.url) parts.push(payload.url);
  }
  return parts.join('\n\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
