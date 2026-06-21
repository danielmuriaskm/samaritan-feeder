import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class ShodanAdapter extends BaseAdapter {
  readonly kind = 'shodan' as const;
  readonly name = 'Shodan (Host Intelligence)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      errors.push('config.apiKey is required');
    }
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required (IP address or search query)');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const apiKey = String(config.apiKey);
    const query = String(config.query).trim();
    const maxItems = Math.min(typeof config.maxItems === 'number' ? config.maxItems : 20, 100);
    const sourceId = String(config.sourceId ?? `shodan_${this.slugify(query)}`);
    const since = cursor ? Number(cursor) : 0;

    const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(query);

    let results: ShodanHost[] = [];

    if (isIp) {
      const url = `https://api.shodan.io/shodan/host/${encodeURIComponent(query)}?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        throw new Error(`Shodan host lookup failed: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as ShodanHost;
      if (data.ip_str) results = [data];
    } else {
      const url = `https://api.shodan.io/shodan/host/search?query=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}&limit=${maxItems}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        throw new Error(`Shodan search failed: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as { matches?: ShodanHost[] };
      results = data.matches ?? [];
    }

    const events: RawEvent[] = [];
    for (const host of results) {
      const eventAt = host.last_update ? new Date(host.last_update).getTime() : Date.now();
      if (eventAt <= since) continue;

      const ports = host.ports ?? host.data?.map((d) => d.port).filter(Boolean) ?? [];
      const services = host.data?.map((d) => `${d.port}/${d.transport ?? 'tcp'}: ${d.product ?? d.banner?.slice(0, 60) ?? 'unknown'}`).join('\n') ?? '';
      const cves = host.vulns ? Object.keys(host.vulns) : [];
      const location = host.location
        ? { lat: host.location.latitude, lon: host.location.longitude }
        : undefined;

      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Shodan: ${host.ip_str}${host.hostnames?.[0] ? ` (${host.hostnames[0]})` : ''}`,
            content: [
              `IP: ${host.ip_str}`,
              `Hostnames: ${host.hostnames?.join(', ') || 'none'}`,
              `ISP: ${host.isp || host.org || 'unknown'}`,
              `OS: ${host.os || 'unknown'}`,
              `Open ports: ${ports.join(', ') || 'none detected'}`,
              services ? `Services:\n${services}` : '',
              cves.length ? `CVEs: ${cves.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            rawData: host as unknown as Record<string, unknown>,
            eventAt,
            confidence: cves.length > 0 ? 0.9 : ports.length > 0 ? 0.75 : 0.5,
            location,
            tags: {
              ip: host.ip_str,
              hostnames: host.hostnames,
              ports,
              cves,
              isp: host.isp,
              org: host.org,
              os: host.os,
              country: host.location?.country_name,
              query,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const apiKey = String(config.apiKey);
    const url = `https://api.shodan.io/api-info?key=${encodeURIComponent(apiKey)}`;
    const start = performance.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private slugify(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }
}

interface ShodanHost {
  ip_str: string;
  hostnames?: string[];
  ports?: number[];
  data?: Array<{ port: number; transport?: string; product?: string; banner?: string }>;
  vulns?: Record<string, unknown>;
  isp?: string;
  org?: string;
  os?: string;
  location?: { latitude: number; longitude: number; country_name?: string };
  last_update?: string;
}
