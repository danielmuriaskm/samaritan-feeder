import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class InstagramAdapter extends BaseAdapter {
  readonly kind = 'instagram';
  readonly name = 'Instagram (Public Profiles)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.username !== 'string' || config.username.length === 0) {
      errors.push('config.username is required (public profile username, no @)');
    }
    if (config.proxyUrl !== undefined && typeof config.proxyUrl !== 'string') {
      errors.push('config.proxyUrl must be a string');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const username = String(config.username).replace(/^@/, '');
    const proxyUrl = config.proxyUrl ? String(config.proxyUrl) : undefined;
    const sourceId = String(config.sourceId ?? `instagram_${username}`);
    const since = cursor ? Number(cursor) : 0;

    // Try multiple strategies in order of reliability
    const strategies: Array<() => Promise<RawEvent[]>> = [
      () => this.scrapeViaProxy(proxyUrl, username, sourceId, since),
      () => this.scrapeDirect(username, sourceId, since),
    ];

    for (const strategy of strategies) {
      try {
        const events = await strategy();
        if (events.length > 0) return events;
      } catch (err) {
        console.warn(`[instagram] Strategy failed for ${username}:`, err instanceof Error ? err.message : String(err));
      }
    }

    return [];
  }

  private async scrapeDirect(username: string, sourceId: string, since: number): Promise<RawEvent[]> {
    const url = `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'X-IG-App-ID': '936619743392459',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Direct scrape failed: ${res.status}`);
    }

    const json = (await res.json()) as IgResponse;
    return this.parsePosts(json, sourceId, since);
  }

  private async scrapeViaProxy(proxyUrl: string | undefined, username: string, sourceId: string, since: number): Promise<RawEvent[]> {
    if (!proxyUrl) throw new Error('No proxy configured');
    const res = await fetch(`${proxyUrl}/instagram/profile?username=${encodeURIComponent(username)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Proxy scrape failed: ${res.status}`);
    }

    const json = (await res.json()) as IgResponse;
    return this.parsePosts(json, sourceId, since);
  }

  private parsePosts(json: IgResponse, sourceId: string, since: number): RawEvent[] {
    const edges = json.data?.user?.edge_owner_to_timeline_media?.edges ?? [];
    const events: RawEvent[] = [];

    for (const edge of edges) {
      const node = edge.node;
      const createdAt = (node.taken_at_timestamp ?? 0) * 1000;
      if (createdAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 100) ?? 'Instagram post',
            content: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
            rawData: node,
            mediaUrls: node.display_url ? [node.display_url] : undefined,
            eventAt: createdAt,
            confidence: this.engagementToConfidence(node.edge_liked_by?.count, node.edge_media_to_comment?.count),
            tags: {
              shortcode: node.shortcode,
              is_video: node.is_video,
              likes: node.edge_liked_by?.count,
              comments: node.edge_media_to_comment?.count,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const username = String(config.username).replace(/^@/, '');
    const start = performance.now();
    try {
      const res = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private engagementToConfidence(likes?: number, comments?: number): number {
    const l = likes ?? 0;
    const c = comments ?? 0;
    const raw = Math.log10(1 + l) * 0.15 + Math.log10(1 + c) * 0.1;
    return Math.min(1, Math.max(0.1, raw));
  }
}

interface IgResponse {
  data?: {
    user?: {
      edge_owner_to_timeline_media?: {
        edges: Array<{
          node: {
            shortcode: string;
            taken_at_timestamp: number;
            display_url?: string;
            is_video: boolean;
            edge_media_to_caption?: {
              edges: Array<{ node: { text: string } }>;
            };
            edge_liked_by?: { count: number };
            edge_media_to_comment?: { count: number };
          };
        }>;
      };
    };
  };
}
