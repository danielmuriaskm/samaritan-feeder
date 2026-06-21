import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class PastebinAdapter extends BaseAdapter {
  readonly kind = 'pastebin' as const;
  readonly name = 'Pastebin Scraper';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const keywords = config.keywords;
    if (!Array.isArray(keywords) || keywords.length === 0 || !keywords.every((k) => typeof k === 'string')) {
      errors.push('keywords is required and must be a non-empty array of strings');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const keywords = (config.keywords as string[]).map(String);
    const maxItems = Math.min(Number(config.maxItems || 10), 20);
    const sourceId = this.slugify(String(config.sourceId || keywords.join('_')));
    const since = cursor ? Number(cursor) : Date.now() - 24 * 60 * 60 * 1000;

    const events: RawEvent[] = [];

    for (const keyword of keywords) {
      try {
        // Use psbdmp.ws API for pastebin dumps (no auth, rate-limited)
        const url = `https://psbdmp.ws/api/v3/search/${encodeURIComponent(keyword)}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Samaritan-Feeder/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;

        const data = (await res.json()) as { data?: Array<{ id: string; text?: string; time?: string; tags?: string; email?: string }> };
        const items = data.data ?? [];

        for (const item of items.slice(0, maxItems)) {
          if (!item.id) continue;
          const pasteTime = item.time ? new Date(item.time).getTime() : Date.now();
          if (pasteTime < since) continue;

          const pasteUrl = `https://pastebin.com/${item.id}`;
          const content = item.text || `[Pastebin dump ${item.id}]`;

          events.push(
            this.makeEvent(
              {
                kind: 'text',
                title: `Pastebin: ${keyword} — ${item.id}`,
                content,
                confidence: 0.6,
                tags: {
                  pastebin_id: item.id,
                  pastebin_keyword: keyword,
                  pastebin_url: pasteUrl,
                  pastebin_tags: item.tags,
                  pastebin_email: item.email,
                },
                eventAt: pasteTime,
              },
              sourceId,
            ),
          );
        }
      } catch {
        // ignore per-keyword failures
      }
    }

    return events;
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const res = await fetch('https://pastebin.com', {
        method: 'HEAD',
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
