import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class GistAdapter extends BaseAdapter {
  readonly kind = 'gist' as const;
  readonly name = 'GitHub Gists Search';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.query !== 'string' || config.query.length < 1) {
      errors.push('query is required and must be a non-empty string');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, _cursor?: string): Promise<RawEvent[]> {
    const query = String(config.query);
    const maxItems = Math.min(Number(config.maxItems || 20), 50);
    const sourceId = this.slugify(String(config.sourceId || query));
    // cursor unused — GitHub search API uses pagination tokens if needed later

    const events: RawEvent[] = [];

    try {
      // GitHub Search API for code in gists (no auth for public, but rate-limited)
      const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+in:file&sort=indexed&order=desc&per_page=${maxItems}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Samaritan-Feeder/1.0',
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        if (res.status === 403) {
          console.warn('[gist] GitHub API rate limit hit — consider adding a token');
        }
        return [];
      }

      const data = (await res.json()) as { items?: Array<{
        html_url: string;
        name: string;
        path: string;
        repository?: { full_name: string; html_url: string };
        score?: number;
      }> };

      for (const item of data.items ?? []) {
        const repoName = item.repository?.full_name ?? 'unknown';
        const rawUrl = item.html_url.replace('/blob/', '/raw/');

        events.push(
          this.makeEvent(
            {
              kind: 'text',
              title: `Gist: ${item.name} in ${repoName}`,
              content: `GitHub code result for "${query}":\nFile: ${item.name}\nRepo: ${repoName}\nURL: ${item.html_url}\nRaw: ${rawUrl}`,
              confidence: Math.min(0.5 + (item.score || 0) * 0.01, 0.9),
              eventAt: Date.now(),
              tags: {
                gist_query: query,
                gist_file: item.name,
                gist_repo: repoName,
                gist_url: item.html_url,
                gist_raw_url: rawUrl,
              },
            },
            sourceId,
          ),
        );
      }
    } catch (err) {
      console.error('[gist] Poll failed:', err instanceof Error ? err.message : String(err));
    }

    return events;
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await fetch('https://api.github.com/status', {
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private slugify(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }
}
