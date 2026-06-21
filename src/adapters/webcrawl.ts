import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

export class WebcrawlAdapter extends BaseAdapter {
  readonly kind = 'webcrawl' as const;
  readonly name = 'Web Crawler (Photon-style)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.startUrl !== 'string' || config.startUrl.length === 0) {
      errors.push('config.startUrl is required');
    }
    if (config.maxDepth !== undefined && (typeof config.maxDepth !== 'number' || config.maxDepth < 1 || config.maxDepth > 5)) {
      errors.push('config.maxDepth must be between 1 and 5');
    }
    if (config.maxPages !== undefined && (typeof config.maxPages !== 'number' || config.maxPages < 1 || config.maxPages > 100)) {
      errors.push('config.maxPages must be between 1 and 100');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const startUrl = String(config.startUrl).trim();
    const maxDepth = Math.min(typeof config.maxDepth === 'number' ? config.maxDepth : 2, 5);
    const maxPages = Math.min(typeof config.maxPages === 'number' ? config.maxPages : 20, 100);
    const sourceId = String(config.sourceId ?? `webcrawl_${this.slugify(startUrl)}`);
    const since = cursor ? Number(cursor) : 0;

    const baseDomain = new URL(startUrl).hostname;
    const visited = new Set<string>();
    const toVisit: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];

    const findings: {
      emails: Set<string>;
      files: Set<string>;
      subdomains: Set<string>;
      links: Set<string>;
    } = {
      emails: new Set(),
      files: new Set(),
      subdomains: new Set(),
      links: new Set(),
    };

    while (toVisit.length > 0 && visited.size < maxPages) {
      const { url, depth } = toVisit.shift()!;
      if (visited.has(url) || depth > maxDepth) continue;
      visited.add(url);

      try {
        // SSRF guard: the start URL is source-supplied and every queued URL is
        // extracted from crawled HTML — both are attacker-influenceable, so the
        // destination must be re-validated against private/reserved ranges on
        // every hop (incl. DNS rebinding).
        const res = await safeFetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) continue;

        const html = await res.text();

        // Extract emails
        const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emailMatches) {
          for (const email of emailMatches) {
            findings.emails.add(email.toLowerCase());
          }
        }

        // Extract links
        const linkMatches = html.matchAll(/href="([^"]+)"/g);
        for (const match of linkMatches) {
          const href = match[1];
          if (href.startsWith('mailto:')) {
            const email = href.slice(7).split('?')[0];
            if (email) findings.emails.add(email.toLowerCase());
            continue;
          }

          try {
            const resolved = new URL(href, url).href;
            const resolvedDomain = new URL(resolved).hostname;

            // Same domain links -> queue for crawling
            if (resolvedDomain === baseDomain && resolved.startsWith('http')) {
              findings.links.add(resolved);
              if (!visited.has(resolved) && depth < maxDepth) {
                toVisit.push({ url: resolved, depth: depth + 1 });
              }
            }

            // Subdomain detection
            if (resolvedDomain.endsWith(baseDomain) && resolvedDomain !== baseDomain) {
              findings.subdomains.add(resolvedDomain);
            }

            // File detection
            const lower = resolved.toLowerCase();
            if (lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.pptx') || lower.endsWith('.xlsx')) {
              findings.files.add(resolved);
            }
          } catch {
            // ignore malformed URLs
          }
        }
      } catch {
        // ignore fetch errors
      }
    }

    const eventAt = Date.now();
    if (eventAt <= since) return [];

    const events: RawEvent[] = [];

    // Create events for each finding type
    if (findings.emails.size > 0) {
      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Crawl: ${findings.emails.size} emails found on ${baseDomain}`,
            content: `Discovered emails while crawling ${baseDomain}:\n${Array.from(findings.emails).slice(0, 50).join('\n')}`,
            eventAt,
            confidence: 0.85,
            tags: {
              crawl_source: 'webcrawl',
              crawl_type: 'emails',
              domain: baseDomain,
              start_url: startUrl,
              emails: Array.from(findings.emails).slice(0, 50),
              pages_crawled: visited.size,
            },
          },
          sourceId,
        ),
      );
    }

    if (findings.subdomains.size > 0) {
      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Crawl: ${findings.subdomains.size} subdomains found on ${baseDomain}`,
            content: `Discovered subdomains while crawling ${baseDomain}:\n${Array.from(findings.subdomains).join('\n')}`,
            eventAt,
            confidence: 0.8,
            tags: {
              crawl_source: 'webcrawl',
              crawl_type: 'subdomains',
              domain: baseDomain,
              start_url: startUrl,
              subdomains: Array.from(findings.subdomains),
              pages_crawled: visited.size,
            },
          },
          sourceId,
        ),
      );
    }

    if (findings.files.size > 0) {
      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Crawl: ${findings.files.size} documents found on ${baseDomain}`,
            content: `Discovered documents while crawling ${baseDomain}:\n${Array.from(findings.files).join('\n')}`,
            eventAt,
            confidence: 0.8,
            tags: {
              crawl_source: 'webcrawl',
              crawl_type: 'documents',
              domain: baseDomain,
              start_url: startUrl,
              files: Array.from(findings.files),
              pages_crawled: visited.size,
            },
          },
          sourceId,
        ),
      );
    }

    if (events.length === 0) {
      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Crawl: ${baseDomain} scanned`,
            content: `Crawled ${visited.size} pages on ${baseDomain}. No emails, subdomains, or documents found.`,
            eventAt,
            confidence: 0.5,
            tags: {
              crawl_source: 'webcrawl',
              crawl_type: 'scan',
              domain: baseDomain,
              start_url: startUrl,
              pages_crawled: visited.size,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const startUrl = String(config.startUrl || 'https://example.com');
    const start = performance.now();
    try {
      const res = await safeFetch(startUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private slugify(s: string): string {
    try {
      return new URL(s).hostname.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    } catch {
      return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    }
  }
}
