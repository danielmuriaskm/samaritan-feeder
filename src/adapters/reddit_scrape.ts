import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class RedditScrapeAdapter extends BaseAdapter {
  readonly kind = 'reddit_scrape' as const;
  readonly name = 'Reddit (Scraper)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.subreddit !== 'string' || config.subreddit.length === 0) {
      errors.push('config.subreddit is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const subreddit = String(config.subreddit).replace(/^r\//, '');
    const sort = String(config.sort ?? 'new');
    const maxItems = Math.min(typeof config.maxItems === 'number' ? config.maxItems : 25, 100);
    const sourceId = String(config.sourceId ?? `reddit_scrape_${subreddit}`);
    const since = cursor ? Number(cursor) : 0;

    // Try multiple approaches: old.reddit JSON, libreddit instances
    const posts = await this.fetchPosts(subreddit, sort, maxItems);

    const events: RawEvent[] = [];
    for (const post of posts) {
      const createdAt = (post.created_utc ?? 0) * 1000;
      if (createdAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: post.title,
            content: `${post.selftext ?? ''}\n\nURL: ${post.url ?? `https://reddit.com${post.permalink}`}`,
            mediaUrls: post.thumbnail && post.thumbnail.startsWith('http') ? [post.thumbnail] : undefined,
            eventAt: createdAt,
            confidence: this.scoreToConfidence(post.score, post.num_comments),
            tags: {
              author: post.author,
              subreddit: post.subreddit,
              permalink: post.permalink,
              score: post.score,
              num_comments: post.num_comments,
              upvote_ratio: post.upvote_ratio,
              source: 'reddit_scrape',
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const subreddit = String(config.subreddit || 'worldnews');
    const url = `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/about.json`;
    const start = performance.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private async fetchPosts(subreddit: string, sort: string, limit: number): Promise<RedditPost[]> {
    // Try old.reddit JSON endpoint first (no auth, no rate limit issues)
    try {
      const url = `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=${limit}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        throw new Error(`Reddit scrape returned ${res.status}`);
      }

      const json = (await res.json()) as { data?: { children?: Array<{ data?: RedditPost }> } };
      return (json.data?.children ?? []).map((c) => c.data).filter((p): p is RedditPost => !!p);
    } catch (err) {
      // Fallback: try libreddit instances
      const libredditInstances = [
        'https://libreddit.spike.codes',
        'https://libreddit.kavin.rocks',
        'https://lr.vern.cc',
      ];
      for (const instance of libredditInstances) {
        try {
          return await this.scrapeLibreddit(instance, subreddit, sort, limit);
        } catch {
          // try next
        }
      }
      throw err;
    }
  }

  private async scrapeLibreddit(instance: string, subreddit: string, sort: string, limit: number): Promise<RedditPost[]> {
    const url = `${instance}/r/${encodeURIComponent(subreddit)}/${sort}?layout=compact`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) throw new Error(`Libreddit returned ${res.status}`);

    const html = await res.text();
    const posts: RedditPost[] = [];

    // libreddit uses .post containers
    const postRegex = /<div class="post"[^>]*>.*?<\/div>\s*<\/div>/gs;
    const items = html.match(postRegex) ?? [];

    for (const item of items.slice(0, limit)) {
      const title = this.extractRegex(item, /<h2[^>]*class="post_title"[^>]*>(.*?)<\/h2>/s)?.replace(/<[^>]+>/g, '');
      const author = this.extractRegex(item, /<a[^>]*class="post_author"[^>]*>\/u\/(.*?)<\/a>/);
      const permalink = this.extractRegex(item, /<a[^>]*href="(\/r\/[^"]+)"[^>]*class="post_title"/);
      const score = this.extractNumber(item, /<span[^>]*class="post_score"[^>]*>([\d.KM]+)/);
      const comments = this.extractNumber(item, /<a[^>]*class="post_comments"[^>]*>([\d.KM]+)\s*comment/s);
      const created = this.extractRegex(item, /<span[^>]*class="post_time"[^>]*title="([^"]+)"/);

      if (title) {
        posts.push({
          title,
          author: author ?? 'unknown',
          subreddit,
          permalink: permalink ?? `/r/${subreddit}/comments/unknown`,
          score,
          num_comments: comments,
          upvote_ratio: 0,
          created_utc: created ? new Date(created).getTime() / 1000 : Date.now() / 1000,
        });
      }
    }

    return posts;
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

  private scoreToConfidence(score: number, comments: number): number {
    const s = score ?? 0;
    const c = comments ?? 0;
    const raw = Math.log10(1 + s) * 0.3 + Math.log10(1 + c) * 0.2;
    return Math.min(1, Math.max(0.1, raw));
  }
}

interface RedditPost {
  title: string;
  selftext?: string;
  url?: string;
  permalink: string;
  author: string;
  subreddit: string;
  score: number;
  num_comments: number;
  upvote_ratio: number;
  created_utc: number;
  thumbnail?: string;
}
