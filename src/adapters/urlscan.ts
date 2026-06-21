import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

export class UrlscanAdapter extends BaseAdapter {
  readonly kind = 'urlscan' as const;
  readonly name = 'URLScan.io';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.targetUrl !== 'string' || !config.targetUrl.startsWith('http')) {
      errors.push('targetUrl is required and must be a valid HTTP(S) URL');
    }
    if (config.visibility && !['public', 'unlisted', 'private'].includes(String(config.visibility))) {
      errors.push('visibility must be public, unlisted, or private');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>): Promise<RawEvent[]> {
    const targetUrl = String(config.targetUrl);
    const visibility = String(config.visibility || 'public');
    const apiKey = config.apiKey ? String(config.apiKey) : undefined;
    const sourceId = this.slugify(String(config.sourceId || targetUrl));

    // Submit scan
    const submitRes = await safeFetch('https://urlscan.io/api/v1/scan/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'API-Key': apiKey } : {}),
      },
      body: JSON.stringify({ url: targetUrl, visibility }),
      signal: AbortSignal.timeout(30000),
    });

    if (!submitRes.ok) {
      throw new Error(`URLScan submit failed: ${submitRes.status}`);
    }

    const submit = (await submitRes.json()) as { uuid?: string; message?: string };
    const uuid = submit.uuid;
    if (!uuid) {
      throw new Error('URLScan submit returned no uuid');
    }

    // Poll for result (max 60s)
    let result: Record<string, unknown> | undefined;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const res = await safeFetch(`https://urlscan.io/api/v1/result/${uuid}/`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) continue; // still processing
      if (res.ok) {
        result = (await res.json()) as Record<string, unknown>;
        break;
      }
    }

    if (!result) {
      return [];
    }

    const page = (result.page as Record<string, unknown>) || {};
    const verdicts = (result.verdicts as Record<string, unknown>) || {};
    const overall = (verdicts.overall as Record<string, unknown>) || {};
    const lists = (verdicts.urlscan as Record<string, unknown>) || {};
    const meta = (result.meta as Record<string, unknown>) || {};
    const processors = (meta.processors as Record<string, unknown>) || {};

    const title = `URLScan: ${targetUrl}`;
    const contentLines: string[] = [
      `URL: ${targetUrl}`,
      `UUID: ${uuid}`,
      page.domain ? `Domain: ${page.domain}` : '',
      page.ip ? `IP: ${page.ip}` : '',
      page.country ? `Country: ${page.country}` : '',
      page.server ? `Server: ${page.server}` : '',
      typeof overall.score === 'number' ? `Score: ${overall.score}` : '',
      overall.malicious ? 'Verdict: MALICIOUS' : '',
      Array.isArray(lists.brands) && lists.brands.length ? `Brands: ${(lists.brands as string[]).join(', ')}` : '',
      Array.isArray(processors.downloads) && processors.downloads.length ? `Downloads: ${processors.downloads.length}` : '',
    ].filter(Boolean);

    const event = this.makeEvent(
      {
        kind: 'alert',
        title,
        content: contentLines.join('\n'),
        confidence: overall.malicious ? 0.95 : 0.7,
        eventAt: Date.now(),
        tags: {
          urlscan_uuid: uuid,
          urlscan_url: targetUrl,
          urlscan_domain: page.domain,
          urlscan_ip: page.ip,
          urlscan_country: page.country,
          urlscan_server: page.server,
          urlscan_malicious: overall.malicious ?? false,
          urlscan_score: overall.score,
          urlscan_brands: lists.brands,
          urlscan_report: `https://urlscan.io/result/${uuid}/`,
        },
      },
      sourceId,
    );

    return [event];
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const apiKey = config.apiKey ? String(config.apiKey) : undefined;
      const res = await safeFetch('https://urlscan.io/api/v1/search/?q=domain:google.com&size=1', {
        headers: apiKey ? { 'API-Key': apiKey } : {},
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
