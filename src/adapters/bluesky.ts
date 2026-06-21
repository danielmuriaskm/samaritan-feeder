import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

interface BskyPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record: {
    text?: string;
    createdAt?: string;
  };
  indexedAt: string;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  embed?: {
    images?: Array<{ thumb: string; fullsize: string; alt: string }>;
    external?: { uri: string; title: string; description: string; thumb?: string };
  };
}

interface BskySearchResponse {
  posts?: BskyPost[];
}

interface BskySession {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
}

export class BlueskyAdapter extends BaseAdapter {
  readonly kind = 'bluesky';
  readonly name = 'Bluesky (AT Protocol)';

  // Per-source session cache (sourceId -> session)
  private sessions = new Map<string, { session: BskySession; expiresAt: number }>();

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required (search query)');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    // Optional auth fields
    if (config.handle !== undefined && typeof config.handle !== 'string') {
      errors.push('config.handle must be a string');
    }
    if (config.appPassword !== undefined && typeof config.appPassword !== 'string') {
      errors.push('config.appPassword must be a string');
    }
    if ((config.handle && !config.appPassword) || (!config.handle && config.appPassword)) {
      errors.push('config.handle and config.appPassword must both be provided for authenticated access');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const query = String(config.query);
    const maxItems = typeof config.maxItems === 'number' ? config.maxItems : 25;
    const sourceId = String(config.sourceId ?? `bluesky_${query}`);
    const since = cursor ? Number(cursor) : 0;

    const handle = config.handle ? String(config.handle) : undefined;
    const appPassword = config.appPassword ? String(config.appPassword) : undefined;
    const useAuth = !!(handle && appPassword);

    // Build API URL
    const baseUrl = useAuth ? 'https://bsky.social' : 'https://public.api.bsky.app';
    const url = new URL(`${baseUrl}/xrpc/app.bsky.feed.searchPosts`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(maxItems, 100)));
    url.searchParams.set('sort', 'latest');

    const headers: Record<string, string> = { Accept: 'application/json' };

    if (useAuth) {
      const token = await this.getAccessToken(sourceId, handle, appPassword);
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 304) {
      return []; // no new data since last poll
    }
    if (!res.ok) {
      throw new Error(`Bluesky search failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as BskySearchResponse;
    const posts = json.posts ?? [];

    const events: RawEvent[] = [];
    for (const post of posts) {
      const createdAt = Date.parse(post.record.createdAt ?? post.indexedAt);
      if (Number.isNaN(createdAt) || createdAt <= since) continue;

      const mediaUrls: string[] = [];
      if (post.embed?.images) {
        for (const img of post.embed.images) {
          if (img.thumb) mediaUrls.push(img.thumb);
        }
      }
      if (post.embed?.external?.thumb) {
        mediaUrls.push(post.embed.external.thumb);
      }

      const engagement = (post.likeCount ?? 0) + (post.repostCount ?? 0) + (post.replyCount ?? 0);

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: `${post.author.displayName ?? post.author.handle}: ${post.record.text?.slice(0, 80) ?? ''}`,
            content: post.record.text ?? '',
            rawData: post as unknown as Record<string, unknown>,
            mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
            eventAt: createdAt,
            confidence: this.engagementToConfidence(engagement),
            tags: {
              handle: post.author.handle,
              uri: post.uri,
              likes: post.likeCount,
              reposts: post.repostCount,
              replies: post.replyCount,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const handle = config.handle ? String(config.handle) : undefined;
    const appPassword = config.appPassword ? String(config.appPassword) : undefined;
    const useAuth = !!(handle && appPassword);

    const start = performance.now();
    try {
      const baseUrl = useAuth ? 'https://bsky.social' : 'https://public.api.bsky.app';
      const headers: Record<string, string> = { Accept: 'application/json' };

      if (useAuth && handle && appPassword) {
        const token = await this.getAccessToken(`health_${handle}`, handle, appPassword);
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(
        `${baseUrl}/xrpc/app.bsky.feed.searchPosts?q=test&limit=1`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      return { healthy: res.ok || res.status === 304, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private async getAccessToken(sourceId: string, handle: string, appPassword: string): Promise<string> {
    const cached = this.sessions.get(sourceId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.session.accessJwt;
    }

    const session = await this.createSession(handle, appPassword);
    // Cache for ~1.5 hours (tokens are valid ~2 hours)
    this.sessions.set(sourceId, { session, expiresAt: Date.now() + 90 * 60 * 1000 });
    return session.accessJwt;
  }

  private async createSession(handle: string, appPassword: string): Promise<BskySession> {
    const res = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Bluesky auth failed: ${res.status} ${err}`);
    }

    return (await res.json()) as BskySession;
  }

  private engagementToConfidence(engagement: number): number {
    const raw = Math.log10(1 + engagement) * 0.2;
    return Math.min(1, Math.max(0.1, raw));
  }
}
