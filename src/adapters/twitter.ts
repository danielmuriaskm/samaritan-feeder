import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class TwitterAdapter extends BaseAdapter {
  readonly kind = 'twitter';
  readonly name = 'Twitter/X (API v2)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.bearerToken !== 'string' || config.bearerToken.length === 0) {
      errors.push('config.bearerToken is required for Twitter API v2');
    }
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required (search query or "from:username")');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const bearerToken = String(config.bearerToken);
    const query = String(config.query);
    const maxItems = typeof config.maxItems === 'number' ? Math.min(config.maxItems, 100) : 25;
    const sourceId = String(config.sourceId ?? 'twitter_api');
    const sinceId = cursor ?? undefined;

    const params = new URLSearchParams({
      query,
      max_results: String(maxItems),
      'tweet.fields': 'created_at,public_metrics,author_id,lang,geo',
      expansions: 'author_id,geo.place_id',
      'user.fields': 'username,name',
      'place.fields': 'full_name,geo',
    });
    if (sinceId) params.set('since_id', sinceId);

    const url = `https://api.twitter.com/2/tweets/search/recent?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'User-Agent': 'Samaritan-Feeder/0.1',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Twitter API error: ${res.status} ${text}`);
    }

    const json = (await res.json()) as TwitterResponse;
    const tweets = json.data ?? [];
    const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
    const places = new Map((json.includes?.places ?? []).map((p) => [p.id, p]));

    const events: RawEvent[] = [];
    for (const tweet of tweets) {
      const author = users.get(tweet.author_id);
      const createdAt = Date.parse(tweet.created_at);

      let location: { lat: number; lon: number } | undefined;
      if (tweet.geo?.coordinates) {
        const [lon, lat] = tweet.geo.coordinates.coordinates;
        location = { lat, lon };
      } else if (tweet.geo?.place_id) {
        const place = places.get(tweet.geo.place_id);
        if (place?.geo?.bbox) {
          const [minLon, minLat, maxLon, maxLat] = place.geo.bbox;
          location = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
        }
      }

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: `Tweet by @${author?.username ?? 'unknown'}`,
            content: tweet.text,
            rawData: tweet as unknown as Record<string, unknown>,
            eventAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
            confidence: this.engagementToConfidence(tweet.public_metrics),
            location,
            tags: {
              author_id: tweet.author_id,
              author_username: author?.username,
              author_name: author?.name,
              lang: tweet.lang,
              retweets: tweet.public_metrics?.retweet_count,
              replies: tweet.public_metrics?.reply_count,
              likes: tweet.public_metrics?.like_count,
              place_name: places.get(tweet.geo?.place_id ?? '')?.full_name,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const bearerToken = String(config.bearerToken);
    const start = performance.now();
    try {
      const res = await fetch('https://api.twitter.com/2/tweets/search/recent?query=test&max_results=1', {
        headers: { Authorization: `Bearer ${bearerToken}` },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private engagementToConfidence(metrics?: { retweet_count?: number; reply_count?: number; like_count?: number }): number {
    const r = metrics?.retweet_count ?? 0;
    const l = metrics?.like_count ?? 0;
    const raw = Math.log10(1 + r) * 0.2 + Math.log10(1 + l) * 0.1;
    return Math.min(1, Math.max(0.1, raw));
  }
}

interface TwitterResponse {
  data?: Tweet[];
  includes?: { users?: TwitterUser[]; places?: TwitterPlace[] };
  meta?: { newest_id?: string; oldest_id?: string };
}

interface Tweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  lang: string;
  geo?: {
    coordinates?: { type: 'Point'; coordinates: [number, number] };
    place_id?: string;
  };
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
}

interface TwitterPlace {
  id: string;
  full_name: string;
  geo?: { type: 'Feature'; bbox: [number, number, number, number] };
}

interface TwitterUser {
  id: string;
  username: string;
  name: string;
}
