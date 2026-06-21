import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

interface YouTubeSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelTitle?: string;
    channelId?: string;
    liveBroadcastContent?: string;
    thumbnails?: {
      default?: { url: string };
      medium?: { url: string };
      high?: { url: string };
    };
  };
}

interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
  nextPageToken?: string;
  pageInfo?: { totalResults: number; resultsPerPage: number };
}

export class YouTubeAdapter extends BaseAdapter {
  readonly kind = 'youtube';
  readonly name = 'YouTube (Geo Search)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      errors.push('config.apiKey is required (YouTube Data API v3 key)');
    }
    if (typeof config.location !== 'string' || !/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(String(config.location))) {
      errors.push('config.location must be "lat,lon" (e.g. "40.7128,-74.006")');
    }
    if (config.query !== undefined && typeof config.query !== 'string') {
      errors.push('config.query must be a string');
    }
    if (config.locationRadius !== undefined && typeof config.locationRadius !== 'string') {
      errors.push('config.locationRadius must be a string like "50km" or "10mi"');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const apiKey = String(config.apiKey);
    const location = String(config.location);
    const locationRadius = String(config.locationRadius ?? '50km');
    const query = String(config.query ?? '');
    const maxItems = typeof config.maxItems === 'number' ? Math.min(config.maxItems, 50) : 25;
    const sourceId = String(config.sourceId ?? `youtube_${location}`);
    const eventType = config.eventType === 'live' ? 'live' : undefined;
    const since = cursor ? Number(cursor) : 0;

    const [lat, lon] = location.split(',').map((s) => parseFloat(s.trim()));

    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      location,
      locationRadius,
      maxResults: String(maxItems),
      order: 'date',
      key: apiKey,
    });
    if (query) params.set('q', query);
    if (eventType) params.set('eventType', eventType);
    if (cursor) params.set('publishedAfter', new Date(since).toISOString());

    const url = `https://youtube.googleapis.com/youtube/v3/search?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`YouTube API error: ${res.status} ${text}`);
    }

    const json = (await res.json()) as YouTubeSearchResponse;
    const items = json.items ?? [];

    const events: RawEvent[] = [];
    for (const item of items) {
      const snippet = item.snippet;
      const videoId = item.id?.videoId;
      if (!snippet || !videoId) continue;

      const publishedAt = Date.parse(snippet.publishedAt ?? '');
      if (Number.isNaN(publishedAt) || publishedAt <= since) continue;

      const isLive = snippet.liveBroadcastContent === 'live';
      const thumbnails = snippet.thumbnails;
      const thumbUrl = thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url;

      events.push(
        this.makeEvent(
          {
            kind: 'visual',
            title: snippet.title ?? 'YouTube video',
            content: `${snippet.description ?? ''}\n\nChannel: ${snippet.channelTitle ?? 'unknown'}\nURL: https://youtube.com/watch?v=${videoId}`,
            rawData: item as unknown as Record<string, unknown>,
            mediaUrls: thumbUrl ? [thumbUrl] : undefined,
            eventAt: publishedAt,
            confidence: isLive ? 0.85 : 0.6,
            location: { lat, lon },
            tags: {
              videoId,
              channelId: snippet.channelId,
              channelTitle: snippet.channelTitle,
              isLive,
              query,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const apiKey = String(config.apiKey);
    const start = performance.now();
    try {
      const url = `https://youtube.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=test&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
