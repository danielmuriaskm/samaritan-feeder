import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

interface TelegramMessage {
  id: number;
  text?: string;
  date?: string;
  views?: number;
  media?: {
    type: 'photo' | 'video';
    thumb?: string;
    url?: string;
  };
  author?: string;
  forwarded?: boolean;
}

export class TelegramAdapter extends BaseAdapter {
  readonly kind = 'telegram';
  readonly name = 'Telegram (Public Channels)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.channel !== 'string' || config.channel.length === 0) {
      errors.push('config.channel is required (public channel username, no @)');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const channel = String(config.channel).replace(/^@/, '');
    const maxItems = typeof config.maxItems === 'number' ? Math.min(config.maxItems, 30) : 20;
    const sourceId = String(config.sourceId ?? `telegram_${channel}`);
    const since = cursor ? Number(cursor) : 0;

    const url = `https://t.me/s/${encodeURIComponent(channel)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Telegram fetch failed: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    const messages = this.parseMessages(html, maxItems);

    const events: RawEvent[] = [];
    for (const msg of messages) {
      const createdAt = msg.date ? Date.parse(msg.date) : Date.now();
      if (Number.isNaN(createdAt) || createdAt <= since) continue;

      const hasMedia = msg.media && (msg.media.thumb || msg.media.url);
      const confidence = this.engagementToConfidence(msg.views ?? 0);

      events.push(
        this.makeEvent(
          {
            kind: hasMedia ? 'visual' : 'social_post',
            title: msg.text?.slice(0, 120) ?? `Telegram message #${msg.id}`,
            content: `${msg.text ?? ''}\n\nURL: https://t.me/${channel}/${msg.id}`,
            rawData: msg as unknown as Record<string, unknown>,
            mediaUrls: msg.media?.thumb ? [msg.media.thumb] : msg.media?.url ? [msg.media.url] : undefined,
            eventAt: createdAt,
            confidence,
            tags: {
              channel,
              messageId: msg.id,
              author: msg.author,
              views: msg.views,
              forwarded: msg.forwarded,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const channel = String(config.channel).replace(/^@/, '');
    const start = performance.now();
    try {
      const res = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private parseMessages(html: string, maxItems: number): TelegramMessage[] {
    const messages: TelegramMessage[] = [];

    // Telegram web preview uses div.tgme_widget_message
    const messageRegex = /<div class="tgme_widget_message"[^>]*>.*?data-post="([^"]+)".*?<\/div>\s*<\/div>\s*<\/div>/gs;
    let match: RegExpExecArray | null;

    while ((match = messageRegex.exec(html)) !== null && messages.length < maxItems) {
      const block = match[0];
      const postRef = match[1]; // format: "channel/123"
      const msgId = Number(postRef.split('/')[1]);

      // Extract text
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)<\/div>/s);
      const text = textMatch ? this.stripHtml(textMatch[1]) : undefined;

      // Extract date
      const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
      const date = dateMatch ? dateMatch[1] : undefined;

      // Extract views
      const viewsMatch = block.match(/<span class="tgme_widget_message_views[^"]*"[^>]*>([\d,]+)/);
      const views = viewsMatch ? Number(viewsMatch[1].replace(/,/g, '')) : 0;

      // Extract photo thumbnail
      const photoMatch = block.match(/<a[^>]*class="tgme_widget_message_photo_wrap[^"]*"[^>]*style="background-image:url\('([^']+)'\)/);
      const thumb = photoMatch ? photoMatch[1] : undefined;

      // Extract forwarded status
      const forwarded = block.includes('tgme_widget_message_forwarded_from_name');

      messages.push({
        id: msgId,
        text,
        date,
        views,
        media: thumb ? { type: 'photo', thumb } : undefined,
        forwarded,
      });
    }

    return messages;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  private engagementToConfidence(views: number): number {
    const raw = Math.log10(1 + views) * 0.15;
    return Math.min(1, Math.max(0.1, raw));
  }
}
