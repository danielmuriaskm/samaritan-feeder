import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { config } from '../config.js';

export class DarksearchAdapter extends BaseAdapter {
  readonly kind = 'darksearch' as const;
  readonly name = 'DarkSearch (Leaked Data)';

  validate(cfg: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof cfg.query !== 'string' || cfg.query.length < 1) {
      errors.push('query is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(cfg: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const query = String(cfg.query);
    const maxItems = Math.min(Number(cfg.maxItems || 20), 50);
    const sourceId = this.slugify(String(cfg.sourceId || query));
    const since = cursor ? Number(cursor) : Date.now() - 24 * 60 * 60 * 1000;

    const events: RawEvent[] = [];

    try {
      // DarkSearch.io API (public tier available)
      const url = `https://darksearch.io/api/search?query=${encodeURIComponent(query)}&page=1`;
      const headers: Record<string, string> = {
        'User-Agent': 'Samaritan-Feeder/1.0',
        Accept: 'application/json',
      };
      if (config.DARKSEARCH_API_KEY) {
        headers['Authorization'] = `Bearer ${config.DARKSEARCH_API_KEY}`;
      }

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.warn(`[darksearch] API returned ${res.status}`);
        return [];
      }

      const data = (await res.json()) as {
        data?: Array<{
          title?: string;
          link?: string;
          snippet?: string;
          date?: string;
          source?: string;
        }>;
      };

      for (const item of (data.data ?? []).slice(0, maxItems)) {
        const eventAt = item.date ? new Date(item.date).getTime() : Date.now();
        if (eventAt < since) continue;

        events.push(
          this.makeEvent(
            {
              kind: 'text',
              title: item.title || `DarkSearch: ${query}`,
              content: item.snippet || `[DarkSearch result: ${item.link}]`,
              confidence: 0.6,
              eventAt,
              tags: {
                darksearch_query: query,
                darksearch_link: item.link,
                darksearch_source: item.source,
              },
            },
            sourceId,
          ),
        );
      }
    } catch (err) {
      console.error('[darksearch] Poll failed:', err instanceof Error ? err.message : String(err));
    }

    return events;
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await fetch('https://darksearch.io/api/search?query=test&page=1', {
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
