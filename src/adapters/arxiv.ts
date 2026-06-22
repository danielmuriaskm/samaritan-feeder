import { RssAdapter } from './rss.js';
import type { RawEvent } from '../types.js';

/**
 * arXiv adapter.
 *
 * Root cause this fixes: `arxiv` is a declared `SourceKind` (see src/types.ts) but
 * NO adapter was ever registered for it, so the scheduler logged
 * "No adapter for kind: arxiv" and skipped every arXiv source — they went silent
 * with zero events for ~11d while upstream kept publishing. There is no separate
 * arXiv wire format: the public arXiv API returns an Atom feed, which the RSS
 * adapter already parses correctly. So this adapter is a thin shim over
 * {@link RssAdapter}: it translates an arXiv-shaped config (a list of subject
 * categories) into the export-API query URL, then defers to the RSS Atom parser.
 *
 * IMPORTANT wiring note: registration lives in src/adapters/index.ts (a file this
 * change is fenced out of). To activate this adapter, add the single line
 *   registerAdapter(new ArxivAdapter());
 * to that file's bootstrap block. Until then, existing `kind:'arxiv'` sources keep
 * skipping. (Alternatively, point those sources at `kind:'rss'` with the URL this
 * adapter builds — the parse result is identical.)
 *
 * Config:
 *   - `categories`: string[] of arXiv subject classes, e.g. ['cs.AI','cs.CL'].
 *   - `category`: a single category (convenience; merged with `categories`).
 *   - `maxItems`: cap (default 25).
 *   - `url`: optional explicit override — if present, used verbatim (lets an
 *     operator pin any arXiv-API query they like).
 */

// The export host is the API endpoint arXiv asks automated clients to use (the
// www host is for browsers). It returns Atom 1.0.
const ARXIV_API = 'https://export.arxiv.org/api/query';
const VALID_CATEGORY = /^[a-z-]+(\.[a-zA-Z-]+)?$/; // e.g. cs.AI, math.GT, q-bio, stat.ML

export class ArxivAdapter extends RssAdapter {
  override readonly kind = 'arxiv' as const;
  override readonly name = 'arXiv';

  override validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const cats = this.categories(config);
    const hasUrl = typeof config.url === 'string' && config.url.startsWith('http');
    if (!hasUrl && cats.length === 0) {
      errors.push('config must provide a non-empty "categories" array (or "category"), or an explicit "url"');
    }
    for (const cat of cats) {
      if (!VALID_CATEGORY.test(cat)) errors.push(`invalid arXiv category: ${cat}`);
    }
    if (config.maxItems !== undefined && typeof config.maxItems !== 'number') {
      errors.push('config.maxItems must be a number');
    }
    return { valid: errors.length === 0, errors };
  }

  override async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    // Reuse the RSS adapter's Atom parsing by handing it a config whose `url` is
    // the arXiv API query we build. An explicit `url` in config wins (escape hatch).
    const url = typeof config.url === 'string' && config.url.startsWith('http')
      ? config.url
      : this.buildUrl(config);
    return super.poll({ ...config, url }, cursor);
  }

  override async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const url = typeof config.url === 'string' && config.url.startsWith('http')
      ? config.url
      : this.buildUrl(config);
    return super.health({ ...config, url });
  }

  /** Normalize `category` + `categories` into a clean, de-duped list. */
  private categories(config: Record<string, unknown>): string[] {
    const out: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    };
    if (Array.isArray(config.categories)) for (const c of config.categories) push(c);
    push(config.category);
    return Array.from(new Set(out));
  }

  /**
   * Build a sorted-by-newest arXiv API query for the configured categories. Each
   * category becomes `cat:<id>`, OR-joined, so one source can watch several
   * subject classes (cs.AI/cs.CL/cs.LG/cs.CR) in a single feed.
   */
  buildUrl(config: Record<string, unknown>): string {
    const cats = this.categories(config);
    const maxItems = typeof config.maxItems === 'number' ? config.maxItems : 25;
    const searchQuery = cats.length > 0
      ? cats.map((c) => `cat:${c}`).join(' OR ')
      : 'cat:cs.AI';
    const params = new URLSearchParams({
      search_query: searchQuery,
      sortBy: 'submittedDate',
      sortOrder: 'descending',
      start: '0',
      max_results: String(Math.max(1, Math.min(100, maxItems))),
    });
    return `${ARXIV_API}?${params.toString()}`;
  }
}
