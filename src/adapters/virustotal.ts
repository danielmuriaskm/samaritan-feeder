import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

export class VirusTotalAdapter extends BaseAdapter {
  readonly kind = 'virustotal' as const;
  readonly name = 'VirusTotal (Reputation)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      errors.push('config.apiKey is required');
    }
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required (domain, IP, hash, or URL)');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const apiKey = String(config.apiKey);
    const query = String(config.query).trim();
    const sourceId = String(config.sourceId ?? `vt_${this.slugify(query)}`);

    const type = this.detectType(query);
    let endpoint = '';
    let titlePrefix = '';

    switch (type) {
      case 'domain':
        endpoint = `domains/${encodeURIComponent(query)}`;
        titlePrefix = 'Domain';
        break;
      case 'ip':
        endpoint = `ip_addresses/${encodeURIComponent(query)}`;
        titlePrefix = 'IP';
        break;
      case 'hash':
        endpoint = `files/${encodeURIComponent(query)}`;
        titlePrefix = 'File';
        break;
      case 'url':
        endpoint = `urls/${this.encodeUrl(query)}`;
        titlePrefix = 'URL';
        break;
      default:
        throw new Error(`Unsupported query type: ${query}`);
    }

    const url = `https://www.virustotal.com/api/v3/${endpoint}`;
    const res = await safeFetch(url, {
      headers: { 'x-apikey': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 404) {
      // Not found is OK — return empty, don't error
      return [];
    }
    if (!res.ok) {
      throw new Error(`VirusTotal lookup failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { data?: { attributes?: VtAttributes } };
    const attrs = data.data?.attributes;
    if (!attrs) return [];

    const eventAt = attrs.last_analysis_date ? attrs.last_analysis_date * 1000 : Date.now();
    if (cursor && eventAt <= Number(cursor)) return [];

    const stats = attrs.last_analysis_stats ?? {};
    const malicious = stats.malicious ?? 0;
    const suspicious = stats.suspicious ?? 0;
    const harmless = stats.harmless ?? 0;
    const total = malicious + suspicious + harmless + (stats.undetected ?? 0);
    const score = total > 0 ? (malicious + suspicious) / total : 0;

    const contentLines: string[] = [
      `${titlePrefix}: ${query}`,
      `Reputation: ${attrs.reputation ?? 'unknown'}`,
      `Malicious: ${malicious}`,
      `Suspicious: ${suspicious}`,
      `Harmless: ${harmless}`,
      `Total vendors: ${total}`,
    ];

    if (type === 'domain' || type === 'ip') {
      if (attrs.as_owner) contentLines.push(`AS Owner: ${attrs.as_owner}`);
      if (attrs.country) contentLines.push(`Country: ${attrs.country}`);
      if (attrs.network) contentLines.push(`Network: ${attrs.network}`);
    }

    if (type === 'hash') {
      if (attrs.meaningful_name) contentLines.push(`Name: ${attrs.meaningful_name}`);
      if (attrs.type_description) contentLines.push(`Type: ${attrs.type_description}`);
      if (attrs.size) contentLines.push(`Size: ${attrs.size} bytes`);
    }

    if (attrs.last_analysis_results && typeof attrs.last_analysis_results === 'object') {
      const detections = Object.entries(attrs.last_analysis_results)
        .filter(([, r]) => (r as VtEngineResult).category === 'malicious' || (r as VtEngineResult).category === 'suspicious')
        .slice(0, 10)
        .map(([engine, r]) => `${engine}: ${(r as VtEngineResult).result}`);
      if (detections.length) contentLines.push(`Detections:\n${detections.join('\n')}`);
    }

    const event = this.makeEvent(
      {
        kind: 'alert',
        title: `VirusTotal: ${query} (${malicious}/${total} detections)`,
        content: contentLines.join('\n'),
        rawData: data.data as unknown as Record<string, unknown>,
        eventAt,
        confidence: Math.min(1, Math.max(0.3, score)),
        tags: {
          query,
          type,
          malicious,
          suspicious,
          harmless,
          total,
          reputation: attrs.reputation,
          as_owner: attrs.as_owner,
          country: attrs.country,
        },
      },
      sourceId,
    );

    return [event];
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const apiKey = String(config.apiKey);
    const url = 'https://www.virustotal.com/api/v3/domains/google.com';
    const start = performance.now();
    try {
      const res = await safeFetch(url, {
        headers: { 'x-apikey': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private detectType(query: string): 'domain' | 'ip' | 'hash' | 'url' {
    if (/^https?:\/\//.test(query)) return 'url';
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(query)) return 'ip';
    if (/^[a-f0-9]{32}$/i.test(query) || /^[a-f0-9]{40}$/i.test(query) || /^[a-f0-9]{64}$/i.test(query)) return 'hash';
    return 'domain';
  }

  private encodeUrl(url: string): string {
    // VirusTotal uses base64url-encoded URL for the URL endpoint
    return Buffer.from(url).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  private slugify(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }
}

interface VtAttributes {
  reputation?: number;
  last_analysis_date?: number;
  last_analysis_stats?: { malicious?: number; suspicious?: number; harmless?: number; undetected?: number };
  last_analysis_results?: Record<string, VtEngineResult>;
  as_owner?: string;
  country?: string;
  network?: string;
  meaningful_name?: string;
  type_description?: string;
  size?: number;
}

interface VtEngineResult {
  category: string;
  result: string;
}
