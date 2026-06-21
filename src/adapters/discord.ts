import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string;
  author?: {
    username: string;
    global_name?: string;
  };
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
    image?: { url?: string };
    thumbnail?: { url?: string };
    footer?: { text?: string };
    timestamp?: string;
  }>;
  attachments?: Array<{
    url: string;
    content_type?: string;
    filename: string;
  }>;
  reactions?: Array<{
    count: number;
  }>;
  mentions?: unknown[];
  mention_everyone?: boolean;
  pinned?: boolean;
}

export class DiscordAdapter extends BaseAdapter {
  readonly kind = 'discord';
  readonly name = 'Discord (Bot Monitor)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.botToken !== 'string' || config.botToken.length === 0) {
      errors.push('config.botToken is required (Discord bot token)');
    }
    if (typeof config.channelId !== 'string' || config.channelId.length === 0) {
      errors.push('config.channelId is required (Discord channel ID)');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const botToken = String(config.botToken);
    const channelId = String(config.channelId);
    const maxItems = typeof config.maxItems === 'number' ? Math.min(config.maxItems, 100) : 50;
    const sourceId = String(config.sourceId ?? `discord_${channelId}`);
    const since = cursor ? Number(cursor) : 0;

    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=${maxItems}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
        'User-Agent': 'Samaritan-Feeder/0.1',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord API error: ${res.status} ${text}`);
    }

    const messages = (await res.json()) as DiscordMessage[];
    const events: RawEvent[] = [];

    for (const msg of messages) {
      const createdAt = Date.parse(msg.timestamp);
      if (Number.isNaN(createdAt) || createdAt <= since) continue;
      if (!msg.content && (!msg.embeds || msg.embeds.length === 0) && (!msg.attachments || msg.attachments.length === 0)) {
        continue;
      }

      const mediaUrls: string[] = [];
      for (const att of msg.attachments ?? []) {
        if (att.content_type?.startsWith('image/') || att.content_type?.startsWith('video/')) {
          mediaUrls.push(att.url);
        }
      }
      for (const embed of msg.embeds ?? []) {
        if (embed.image?.url) mediaUrls.push(embed.image.url);
        if (embed.thumbnail?.url) mediaUrls.push(embed.thumbnail.url);
      }

      const reactionCount = msg.reactions?.reduce((sum, r) => sum + (r.count ?? 0), 0) ?? 0;
      const confidence = this.engagementToConfidence(reactionCount, msg.mentions?.length ?? 0);

      const title = msg.embeds?.[0]?.title ?? msg.content.slice(0, 120) ?? 'Discord message';
      const content = [
        msg.content,
        msg.embeds?.map((e) => `${e.title ?? ''}\n${e.description ?? ''}\n${e.url ?? ''}`).join('\n---\n'),
        `\nURL: https://discord.com/channels/@me/${channelId}/${msg.id}`,
      ].filter(Boolean).join('\n');

      events.push(
        this.makeEvent(
          {
            kind: mediaUrls.length > 0 ? 'visual' : 'social_post',
            title,
            content: content.slice(0, 4000),
            rawData: msg as unknown as Record<string, unknown>,
            mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
            eventAt: createdAt,
            confidence,
            tags: {
              channelId,
              messageId: msg.id,
              author: msg.author?.username,
              authorDisplay: msg.author?.global_name,
              reactions: reactionCount,
              mentions: msg.mentions?.length ?? 0,
              pinned: msg.pinned,
              mentionEveryone: msg.mention_everyone,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const botToken = String(config.botToken);
    const channelId = String(config.channelId);
    const start = performance.now();
    try {
      const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
        headers: {
          Authorization: `Bot ${botToken}`,
          'User-Agent': 'Samaritan-Feeder/0.1',
        },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private engagementToConfidence(reactions: number, mentions: number): number {
    const raw = Math.log10(1 + reactions) * 0.2 + Math.log10(1 + mentions) * 0.1;
    return Math.min(1, Math.max(0.1, raw));
  }
}
