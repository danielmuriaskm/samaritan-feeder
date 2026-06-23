import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class HnAdapter extends BaseAdapter {
  readonly kind = 'hn';
  readonly name = 'Hacker News (Algolia)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (config.query !== undefined && typeof config.query !== 'string') {
      errors.push('config.query must be a string');
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    if (config.limit !== undefined && typeof config.limit !== 'number') {
      errors.push('config.limit must be a number');
    }
    if (config.which !== undefined && !['top', 'front_page', 'new', 'date'].includes(String(config.which))) {
      errors.push('config.which must be one of: top, front_page, new, date');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const query = String(config.query ?? '');
    const maxItems =
      typeof config.maxItems === 'number' ? config.maxItems
      : typeof config.limit === 'number' ? config.limit
      : 30;
    const sourceId = String(config.sourceId ?? 'hn_algolia');
    const which = String(config.which ?? '').toLowerCase();
    // "top" / "front_page": pull the current front page (high-signal, points-sorted)
    // and let the stable dedupe (below) drop already-seen stories — only NEW
    // front-page entrants persist. This is what the source intends, vs. the old
    // behavior of ingesting the newest-by-date firehose.
    const frontPage = !query && (which === 'top' || which === 'front_page');
    const since = cursor ? Number(cursor) : 0;

    // Algolia search API — no auth needed.
    const url = frontPage
      ? `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${maxItems}`
      : query
      ? `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${maxItems}`
      : `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=${maxItems}`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`HN fetch failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { hits?: HnHit[] };
    const hits = json.hits ?? [];

    const events: RawEvent[] = [];
    for (const hit of hits) {
      const createdAt = (hit.created_at_i ?? 0) * 1000;
      // In date/newest mode the cursor prevents re-pulling the whole list each poll.
      // In front-page mode older stories are expected (a story can sit on the front
      // page for hours), so we rely on the stable dedupe key instead of the cursor.
      if (!frontPage && createdAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'social_post',
            title: hit.title,
            content: `${hit.story_text ?? hit.comment_text ?? ''}\n\nURL: ${hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`}`,
            rawData: hit as unknown as Record<string, unknown>,
            eventAt: createdAt,
            confidence: this.scoreToConfidence(hit.points, hit.num_comments),
            // Stable per-story dedupe key (the HN item id is globally unique and
            // immutable). Collapses re-ingests across polls and across overlapping
            // HN feeds — the same fix pattern as the NWS/USGS adapters. Without it
            // the adapter fell back to content hashing, which drifted as a story's
            // text/url changed and let the same story persist multiple times.
            dedupeContent: `hn:${hit.objectID}`,
            tags: {
              author: hit.author,
              object_id: hit.objectID,
              points: hit.points,
              num_comments: hit.num_comments,
              url: hit.url,
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
      const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=1', {
        signal: AbortSignal.timeout(5000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private scoreToConfidence(points?: number, comments?: number): number {
    const p = points ?? 0;
    const c = comments ?? 0;
    const raw = Math.log10(1 + p) * 0.25 + Math.log10(1 + c) * 0.15;
    return Math.min(1, Math.max(0.1, raw));
  }
}

interface HnHit {
  objectID: string;
  title: string;
  url?: string;
  author: string;
  points?: number;
  num_comments?: number;
  story_text?: string;
  comment_text?: string;
  created_at_i: number;
}
