import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class CensysAdapter extends BaseAdapter {
  readonly kind = 'censys' as const;
  readonly name = 'Censys (Host Search)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.apiId !== 'string' || config.apiId.length === 0) {
      errors.push('config.apiId is required');
    }
    if (typeof config.apiSecret !== 'string' || config.apiSecret.length === 0) {
      errors.push('config.apiSecret is required');
    }
    if (typeof config.query !== 'string' || config.query.length === 0) {
      errors.push('config.query is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const apiId = String(config.apiId);
    const apiSecret = String(config.apiSecret);
    const query = String(config.query);
    const maxItems = Math.min(typeof config.maxItems === 'number' ? config.maxItems : 20, 100);
    const sourceId = String(config.sourceId ?? `censys_${this.slugify(query)}`);
    const since = cursor ? Number(cursor) : 0;

    const auth = Buffer.from(`${apiId}:${apiSecret}`).toString('base64');
    const url = `https://search.censys.io/api/v2/hosts/search?q=${encodeURIComponent(query)}&per_page=${maxItems}`;

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      throw new Error(`Censys search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { result?: { hits?: CensysHost[] } };
    const hits = data.result?.hits ?? [];

    const events: RawEvent[] = [];
    for (const host of hits) {
      const eventAt = host.last_updated_at ? new Date(host.last_updated_at).getTime() : Date.now();
      if (eventAt <= since) continue;

      const services = host.services?.map((s) => `${s.port}/${s.transport_protocol}: ${s.service_name ?? 'unknown'}`).join(', ') ?? '';
      const location = host.location?.coordinates?.latitude
        ? { lat: host.location.coordinates.latitude, lon: host.location.coordinates.longitude }
        : undefined;

      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Censys: ${host.ip}`,
            content: [
              `IP: ${host.ip}`,
              `Services: ${services || 'none detected'}`,
              `OS: ${host.operating_system?.uniform_resource_identifier ?? 'unknown'}`,
              host.autonomous_system?.name ? `ASN: ${host.autonomous_system.name} (${host.autonomous_system.asn})` : '',
              host.location?.country ? `Country: ${host.location.country}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            rawData: host as unknown as Record<string, unknown>,
            eventAt,
            confidence: (host.services?.length ?? 0) > 0 ? 0.75 : 0.5,
            location,
            tags: {
              ip: host.ip,
              services: host.services?.map((s) => s.port),
              os: host.operating_system?.uniform_resource_identifier,
              asn: host.autonomous_system?.asn,
              asn_name: host.autonomous_system?.name,
              country: host.location?.country,
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
    const apiId = String(config.apiId);
    const apiSecret = String(config.apiSecret);
    const auth = Buffer.from(`${apiId}:${apiSecret}`).toString('base64');
    const url = 'https://search.censys.io/api/v2/hosts/search?q=8.8.8.8&per_page=1';
    const start = performance.now();
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
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

interface CensysHost {
  ip: string;
  services?: Array<{ port: number; transport_protocol: string; service_name?: string }>;
  operating_system?: { uniform_resource_identifier?: string };
  autonomous_system?: { asn?: number; name?: string };
  location?: { country?: string; coordinates?: { latitude: number; longitude: number } };
  last_updated_at?: string;
}
