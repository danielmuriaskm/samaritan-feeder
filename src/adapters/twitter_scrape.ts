import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class TwitterScrapeAdapter extends BaseAdapter {
  readonly kind = 'twitter_scrape' as const;
  readonly name = 'Twitter / X (Scraper)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const query = String(config.query).trim();
    const maxItems = Math.min(typeof config.maxItems === 'number' ? config.maxItems : 20, 50);
    const sourceId = String(config.sourceId ?? `twitter_scrape_${this.slugify(query)}`);
    const since = cursor ? Number(cursor) : 0;

    // Try nitter instances first (no auth, no rate limits)
    const nitterInstances = [
      'https://nitter.net',
      'https://nitter.it',
      'https://nitter.privacydev.net',
      'https://nitter.cz',
    ];

    let tweets: Tweet[] = [];
    for (const instance of nitterInstances) {
      try {
        tweets = await this.scrapeNitter(instance, query, maxItems);
        if (tweets.length > 0) break;
      } catch (err) {
        console.warn(`[twitter_scrape] ${instance} failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    const events: RawEvent[] = [];
    for (const tweet of tweets) {
      const eventAt = tweet.date ? new Date(tweet.date).getTime() : Date.now();
      if (eventAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: `Tweet by @${tweet.username}`,
            content: tweet.text,
            eventAt,
            confidence: tweet.likes ? Math.min(1, 0.3 + Math.log10(1 + tweet.likes) * 0.15) : 0.5,
            tags: {
              author: tweet.username,
              display_name: tweet.displayName,
              likes: tweet.likes,
              retweets: tweet.retweets,
              replies: tweet.replies,
              url: tweet.url,
              query,
              source: 'nitter_scrape',
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(_config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await fetch('https://nitter.net', {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private async scrapeNitter(instance: string, query: string, maxItems: number): Promise<Tweet[]> {
    const url = `${instance}/search?f=tweets&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      throw new Error(`Nitter returned ${res.status}`);
    }

    const html = await res.text();
    const tweets: Tweet[] = [];

    // Parse tweet cards from nitter HTML
    // Nitter structure: .timeline-item containers with .tweet-content
    const itemRegex = /<div class="timeline-item"[^>]*>.*?<\/div>\s*<\/div>\s*<\/div>/gs;
    const items = html.match(itemRegex) ?? [];

    for (const item of items.slice(0, maxItems)) {
      const username = this.extractRegex(item, /<a href="\/([^"\/]+)" class="username">/);
      const displayName = this.extractRegex(item, /<a[^>]*class="fullname"[^>]*>(.*?)<\/a>/s);
      const text = this.extractRegex(item, /<div class="tweet-content[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>/s)
        ?.replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const dateStr = this.extractRegex(item, /<span[^>]*title="([^"]+)"[^>]*class="tweet-date"/);
      const likes = this.extractNumber(item, /<span[^>]*class="icon-heart"[^>]*>.*?<\/svg>\s*(\d+)/s);
      const retweets = this.extractNumber(item, /<span[^>]*class="icon-retweet"[^>]*>.*?<\/svg>\s*(\d+)/s);
      const replies = this.extractNumber(item, /<span[^>]*class="icon-comment"[^>]*>.*?<\/svg>\s*(\d+)/s);
      const tweetUrl = this.extractRegex(item, /<a href="(\/[^"]+)"[^>]*class="tweet-date"/);

      if (username && text) {
        tweets.push({
          username,
          displayName: displayName ?? username,
          text,
          date: dateStr ? dateStr.replace(/&.*$/, '') : undefined,
          likes,
          retweets,
          replies,
          url: tweetUrl ? `${instance}${tweetUrl}` : undefined,
        });
      }
    }

    return tweets;
  }

  private extractRegex(html: string, regex: RegExp): string | undefined {
    const match = regex.exec(html);
    return match?.[1];
  }

  private extractNumber(html: string, regex: RegExp): number {
    const match = regex.exec(html);
    if (!match) return 0;
    const val = match[1].replace(/K/i, '000').replace(/M/i, '000000');
    return Number(val) || 0;
  }

  private slugify(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }
}

interface Tweet {
  username: string;
  displayName: string;
  text: string;
  date?: string;
  likes: number;
  retweets: number;
  replies: number;
  url?: string;
}
