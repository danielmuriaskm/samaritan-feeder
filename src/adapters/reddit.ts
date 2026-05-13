import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class RedditAdapter extends BaseAdapter {
  readonly kind = 'reddit';
  readonly name = 'Reddit (Public Subreddits)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.subreddit !== 'string' || config.subreddit.length === 0) {
      errors.push('config.subreddit must be a non-empty string');
    }
    if (config.sort !== undefined && !['new', 'hot', 'top'].includes(String(config.sort))) {
      errors.push('config.sort must be one of: new, hot, top');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const subreddit = String(config.subreddit).replace(/^r\//, '');
    const sort = String(config.sort ?? 'new');
    const maxItems = typeof config.maxItems === 'number' ? config.maxItems : 25;
    const sourceId = String(config.sourceId ?? `reddit_${subreddit}`);
    const since = cursor ? Number(cursor) : 0;

    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=${maxItems}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Samaritan-Feeder/0.1 (+https://github.com/danielmurias-prz/samaritan)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Reddit fetch failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { data?: { children?: Array<{ data?: RedditPost }> } };
    const posts = json.data?.children ?? [];

    const events: RawEvent[] = [];
    for (const child of posts) {
      const post = child.data;
      if (!post) continue;

      const createdAt = (post.created_utc ?? 0) * 1000;
      if (createdAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: post.title,
            content: `${post.selftext ?? ''}\n\nURL: ${post.url ?? `https://reddit.com${post.permalink}`}`,
            rawData: post as unknown as Record<string, unknown>,
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
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const subreddit = String(config.subreddit).replace(/^r\//, '');
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about.json`;
    const start = performance.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Samaritan-Feeder/0.1' },
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
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
