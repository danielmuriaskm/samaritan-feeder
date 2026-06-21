import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class InstagramAdapter extends BaseAdapter {
  readonly kind = 'instagram';
  readonly name = 'Instagram (Public Profiles + Stories)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.username !== 'string' || config.username.length === 0) {
      errors.push('config.username is required (public profile username, no @)');
    }
    if (config.proxyUrl !== undefined && typeof config.proxyUrl !== 'string') {
      errors.push('config.proxyUrl must be a string');
    }
    if (config.sessionCookie !== undefined && typeof config.sessionCookie !== 'string') {
      errors.push('config.sessionCookie must be a string');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const username = String(config.username).replace(/^@/, '');
    const proxyUrl = config.proxyUrl ? String(config.proxyUrl) : undefined;
    const sessionCookie = config.sessionCookie ? String(config.sessionCookie) : undefined;
    const sourceId = String(config.sourceId ?? `instagram_${username}`);
    const since = cursor ? Number(cursor) : 0;

    const allEvents: RawEvent[] = [];

    // 1. Fetch posts (public, no auth needed)
    const postStrategies: Array<() => Promise<RawEvent[]>> = [
      () => this.scrapeViaProxy(proxyUrl, username, sourceId, since),
      () => this.scrapeDirect(username, sourceId, since),
    ];

    for (const strategy of postStrategies) {
      try {
        const events = await strategy();
        allEvents.push(...events);
        break;
      } catch (err) {
        console.warn(`[instagram] Post strategy failed for ${username}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // 2. Fetch stories (requires session cookie)
    if (sessionCookie) {
      try {
        const storyEvents = await this.fetchStories(username, sessionCookie, sourceId, since);
        allEvents.push(...storyEvents);
      } catch (err) {
        console.warn(`[instagram] Stories failed for ${username}:`, err instanceof Error ? err.message : String(err));
      }
    }

    return allEvents;
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

  private async fetchStories(username: string, sessionCookie: string, sourceId: string, since: number): Promise<RawEvent[]> {
    // Step 1: Get user ID from username
    const userId = await this.resolveUserId(username, sessionCookie);
    if (!userId) throw new Error('Could not resolve user ID');

    // Step 2: Fetch stories via reels_media endpoint
    const url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Instagram 269.0.0.18.75 Android',
        Accept: 'application/json',
        'X-IG-App-ID': '936619743392459',
        Cookie: `sessionid=${sessionCookie}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Stories fetch failed: ${res.status}`);
    }

    const json = (await res.json()) as IgStoriesResponse;
    return this.parseStories(json, userId, sourceId, since);
  }

  private async resolveUserId(username: string, sessionCookie: string): Promise<string | undefined> {
    const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Instagram 269.0.0.18.75 Android',
        Accept: 'application/json',
        'X-IG-App-ID': '936619743392459',
        Cookie: `sessionid=${sessionCookie}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return undefined;

    const json = (await res.json()) as IgWebProfileResponse;
    return json.data?.user?.id;
  }

  private parsePosts(json: IgResponse, sourceId: string, since: number): RawEvent[] {
    const edges = json.data?.user?.edge_owner_to_timeline_media?.edges ?? [];
    const events: RawEvent[] = [];

    for (const edge of edges) {
      const node = edge.node;
      const createdAt = (node.taken_at_timestamp ?? 0) * 1000;
      if (createdAt <= since) continue;

      const location = node.location?.lat != null && node.location?.lng != null
        ? { lat: node.location.lat, lon: node.location.lng }
        : undefined;

      events.push(
        this.makeEvent(
          {
            kind: node.is_video ? 'visual' : 'social_post',
            title: node.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 100) ?? 'Instagram post',
            content: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
            rawData: node,
            mediaUrls: node.display_url ? [node.display_url] : undefined,
            eventAt: createdAt,
            confidence: this.engagementToConfidence(node.edge_liked_by?.count, node.edge_media_to_comment?.count),
            location,
            tags: {
              shortcode: node.shortcode,
              is_video: node.is_video,
              likes: node.edge_liked_by?.count,
              comments: node.edge_media_to_comment?.count,
              location_name: node.location?.name,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  private parseStories(json: IgStoriesResponse, userId: string, sourceId: string, since: number): RawEvent[] {
    const reel = json.reels?.[userId];
    const items = reel?.items ?? [];
    const events: RawEvent[] = [];

    for (const item of items) {
      const createdAt = (item.taken_at ?? 0) * 1000;
      if (createdAt <= since) continue;

      // Get best media URL (video preferred, then image)
      const mediaUrl = item.video_versions?.[0]?.url
        ?? item.image_versions2?.candidates?.[0]?.url;

      // Extract location from story_locations sticker
      let location: { lat: number; lon: number } | undefined;
      let locationName: string | undefined;
      if (item.story_locations && item.story_locations.length > 0) {
        const loc = item.story_locations[0].location;
        if (loc?.lat != null && loc?.lng != null) {
          location = { lat: loc.lat, lon: loc.lng };
          locationName = loc.name;
        }
      }

      events.push(
        this.makeEvent(
          {
            kind: 'visual',
            title: `Instagram story — ${locationName ?? 'no location'}`,
            content: `${item.caption?.text ?? ''}\n\nStory from Instagram`.trim(),
            rawData: item as unknown as Record<string, unknown>,
            mediaUrls: mediaUrl ? [mediaUrl] : undefined,
            eventAt: createdAt,
            confidence: location ? 0.75 : 0.5, // Boost confidence when geolocated
            location,
            tags: {
              media_id: item.pk,
              is_story: true,
              is_video: !!item.video_versions,
              location_name: locationName,
              audience: item.audience,
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
    const sessionCookie = config.sessionCookie ? String(config.sessionCookie) : undefined;
    const start = performance.now();

    try {
      // If we have a session cookie, test story access
      if (sessionCookie) {
        const userId = await this.resolveUserId(username, sessionCookie);
        if (userId) {
          const url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Instagram 269.0.0.18.75 Android',
              Cookie: `sessionid=${sessionCookie}`,
              'X-IG-App-ID': '936619743392459',
            },
            signal: AbortSignal.timeout(5000),
          });
          return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
        }
      }

      // Fallback: just check profile exists
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
            location?: {
              name?: string;
              lat?: number;
              lng?: number;
            };
          };
        }>;
      };
    };
  };
}

interface IgWebProfileResponse {
  data?: {
    user?: {
      id: string;
      username?: string;
    };
  };
}

interface IgStoriesResponse {
  reels?: Record<string, {
    items?: Array<{
      pk: string;
      taken_at?: number;
      video_versions?: Array<{ url: string }>;
      image_versions2?: { candidates?: Array<{ url: string }> };
      caption?: { text?: string };
      story_locations?: Array<{
        location?: {
          name?: string;
          lat?: number;
          lng?: number;
        };
      }>;
      audience?: string;
    }>;
  }>;
}
