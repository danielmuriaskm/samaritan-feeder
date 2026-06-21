import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

interface TikTokVideo {
  id: string;
  desc?: string;
  createTime?: string;
  video?: {
    duration?: number;
    playAddr?: string;
    cover?: string;
    dynamicCover?: string;
  };
  author?: {
    uniqueId?: string;
    nickname?: string;
    secUid?: string;
  };
  stats?: {
    diggCount?: number;
    commentCount?: number;
    shareCount?: number;
    playCount?: number;
  };
  locationCreated?: {
    country?: string;
    city?: string;
    district?: string;
  };
  poi?: {
    name?: string;
    address?: string;
    lat?: number;
    lng?: number;
  };
  challenges?: Array<{ title?: string }>;
  contents?: Array<{ text?: string }>;
}

interface TikTokSearchResponse {
  data?: Array<{ item?: TikTokVideo }>;
  hasMore?: boolean;
  cursor?: number;
}

export class TikTokAdapter extends BaseAdapter {
  readonly kind = 'tiktok';
  readonly name = 'TikTok (Web Search)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required (search keyword or hashtag)');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    if (config.proxyUrl !== undefined && typeof config.proxyUrl !== 'string') {
      errors.push('config.proxyUrl must be a string');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const query = String(config.query);
    const maxItems = typeof config.maxItems === 'number' ? Math.min(config.maxItems, 30) : 20;
    const proxyUrl = config.proxyUrl ? String(config.proxyUrl) : undefined;
    const sourceId = String(config.sourceId ?? `tiktok_${query}`);
    const since = cursor ? Number(cursor) : 0;

    // Try proxy first if configured, else direct
    const strategies: Array<() => Promise<TikTokSearchResponse>> = [
      () => this.searchViaProxy(proxyUrl, query, maxItems),
      () => this.searchDirect(query, maxItems),
    ];

    let response: TikTokSearchResponse | undefined;
    let lastError: string | undefined;

    for (const strategy of strategies) {
      try {
        response = await strategy();
        if (response?.data && response.data.length > 0) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!response?.data) {
      throw new Error(lastError ?? 'TikTok search returned no data');
    }

    const events: RawEvent[] = [];
    for (const entry of response.data) {
      const item = entry.item;
      if (!item) continue;

      const createdAt = item.createTime ? Number(item.createTime) * 1000 : Date.now();
      if (createdAt <= since) continue;

      const location = this.extractLocation(item);
      const url = `https://www.tiktok.com/@${item.author?.uniqueId ?? 'user'}/video/${item.id}`;

      events.push(
        this.makeEvent(
          {
            kind: 'visual',
            title: item.desc?.slice(0, 120) ?? 'TikTok video',
            content: `${item.desc ?? ''}\n\nURL: ${url}`,
            rawData: item as unknown as Record<string, unknown>,
            mediaUrls: item.video?.cover ? [item.video.cover] : item.video?.dynamicCover ? [item.video.dynamicCover] : undefined,
            eventAt: createdAt,
            confidence: this.statsToConfidence(item.stats),
            location,
            tags: {
              author: item.author?.uniqueId,
              authorName: item.author?.nickname,
              videoId: item.id,
              duration: item.video?.duration,
              views: item.stats?.playCount,
              likes: item.stats?.diggCount,
              comments: item.stats?.commentCount,
              shares: item.stats?.shareCount,
              hashtags: item.challenges?.map((c) => c.title).filter(Boolean),
              poiName: item.poi?.name,
              poiAddress: item.poi?.address,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const proxyUrl = config.proxyUrl ? String(config.proxyUrl) : undefined;
    const start = performance.now();
    try {
      if (proxyUrl) {
        const res = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(5000) });
        return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
      }
      const res = await fetch('https://www.tiktok.com', {
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

  private async searchDirect(query: string, count: number): Promise<TikTokSearchResponse> {
    // TikTok's web search endpoint — may return 403 without proper signatures
    const url = new URL('https://www.tiktok.com/api/search/general/full/');
    url.searchParams.set('keyword', query);
    url.searchParams.set('offset', '0');
    url.searchParams.set('count', String(count));
    url.searchParams.set('search_source', 'normal_search');
    url.searchParams.set('type', '1'); // videos only

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.tiktok.com/',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`TikTok search failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as TikTokSearchResponse;
  }

  private async searchViaProxy(proxyUrl: string | undefined, query: string, count: number): Promise<TikTokSearchResponse> {
    if (!proxyUrl) throw new Error('No proxy configured');
    const url = new URL(`${proxyUrl}/tiktok/search`);
    url.searchParams.set('keyword', query);
    url.searchParams.set('count', String(count));

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Proxy TikTok search failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as TikTokSearchResponse;
  }

  private extractLocation(item: TikTokVideo): { lat: number; lon: number } | undefined {
    if (item.poi?.lat != null && item.poi?.lng != null) {
      return { lat: item.poi.lat, lon: item.poi.lng };
    }
    return undefined;
  }

  private statsToConfidence(stats?: TikTokVideo['stats']): number {
    const views = stats?.playCount ?? 0;
    const likes = stats?.diggCount ?? 0;
    const raw = Math.log10(1 + views) * 0.08 + Math.log10(1 + likes) * 0.12;
    return Math.min(1, Math.max(0.1, raw));
  }
}
