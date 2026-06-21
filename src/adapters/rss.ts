import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { XMLParser } from 'fast-xml-parser';

export class RssAdapter extends BaseAdapter {
  readonly kind = 'rss';
  readonly name = 'RSS/Atom Feed';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.url !== 'string' || !config.url.startsWith('http')) {
      errors.push('config.url must be a valid HTTP(S) URL');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const url = String(config.url);
    const maxItems = typeof config.maxItems === 'number' ? config.maxItems : 20;
    const sourceId = String(config.sourceId ?? 'rss_unknown');

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Samaritan-Feeder/0.1 (+https://github.com/danielmurias-prz/samaritan)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
    }

    const xml = await res.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      trimValues: true,
      // Disable entity expansion to avoid "Entity expansion limit exceeded"
      // on feeds like The Guardian that have >1000 entities
      processEntities: false,
    });
    const feed = parser.parse(xml);

    const items = this.extractItems(feed);
    const since = cursor ? Number(cursor) : 0;

    const events: RawEvent[] = [];
    for (const item of items.slice(0, maxItems)) {
      const publishedAt = this.parseDate(item.pubDate ?? item.published ?? item.updated);
      if (publishedAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'text',
            title: this.stripHtml(item.title),
            content: this.stripHtml(item.description ?? item.content ?? item.summary ?? ''),
            rawData: item,
            mediaUrls: this.extractMedia(item),
            eventAt: publishedAt,
            tags: {
              link: item.link ?? item.id,
              author: item.author ?? item['dc:creator'],
              categories: item.category,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const url = String(config.url);
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private extractItems(feed: Record<string, unknown>): Array<Record<string, unknown>> {
    const rss = feed.rss;
    if (rss && typeof rss === 'object' && 'channel' in rss) {
      const channel = (rss as Record<string, unknown>).channel as Record<string, unknown>;
      const items = channel.item;
      return Array.isArray(items) ? items : items ? [items as Record<string, unknown>] : [];
    }
    const atom = feed.feed;
    if (atom && typeof atom === 'object') {
      const entry = (atom as Record<string, unknown>).entry;
      return Array.isArray(entry) ? entry : entry ? [entry as Record<string, unknown>] : [];
    }
    return [];
  }

  private parseDate(input: unknown): number {
    if (typeof input !== 'string') return Date.now();
    const ts = Date.parse(input);
    return Number.isNaN(ts) ? Date.now() : ts;
  }

  private stripHtml(input: unknown): string {
    if (typeof input !== 'string') return '';
    return input
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractMedia(item: Record<string, unknown>): string[] | undefined {
    const urls: string[] = [];
    const enclosure = item.enclosure;
    if (enclosure && typeof enclosure === 'object') {
      const href = (enclosure as Record<string, unknown>)['@_url'];
      if (typeof href === 'string') urls.push(href);
    }
    const media = item['media:content'];
    if (media && typeof media === 'object') {
      const href = (media as Record<string, unknown>)['@_url'];
      if (typeof href === 'string') urls.push(href);
    }
    return urls.length > 0 ? urls : undefined;
  }
}
