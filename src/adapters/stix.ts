import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class StixAdapter extends BaseAdapter {
  readonly kind = 'stix' as const;
  readonly name = 'STIX/TAXII Threat Intel Feed';

  validate(cfg: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof cfg.url !== 'string' || !cfg.url.startsWith('http')) {
      errors.push('url must be a valid HTTP(S) URL of a STIX/TAXII collection or feed');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(cfg: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const url = String(cfg.url);
    const maxItems = Math.min(Number(cfg.maxItems || 20), 50);
    const sourceId = this.slugify(String(cfg.sourceId || url));
    const since = cursor ? Number(cursor) : Date.now() - 24 * 60 * 60 * 1000;

    const events: RawEvent[] = [];

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Samaritan-Feeder/1.0',
          Accept: 'application/taxii+json;version=2.1, application/stix+json;version=2.1, application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        console.warn(`[stix] Fetch failed: ${res.status}`);
        return [];
      }

      const data = (await res.json()) as Record<string, unknown>;

      // Handle TAXII 2.1 collection envelope
      let objects: Array<Record<string, unknown>> = [];
      if (Array.isArray(data.objects)) {
        objects = data.objects;
      } else if (typeof data.type === 'string' && data.type !== 'bundle') {
        objects = [data];
      }

      for (const obj of objects.slice(0, maxItems)) {
        const type = String(obj.type ?? 'unknown');
        const created = obj.created ? new Date(String(obj.created)).getTime() : Date.now();
        if (created < since) continue;

        const name = String(obj.name ?? obj.value ?? obj.pattern ?? `${type}-object`);
        const description = String(obj.description ?? obj.pattern ?? JSON.stringify(obj).slice(0, 500));

        events.push(
          this.makeEvent(
            {
              kind: type === 'indicator' || type === 'malware' || type === 'attack-pattern' ? 'alert' : 'text',
              title: `STIX: ${name}`,
              content: description,
              confidence: typeof obj.confidence === 'number' ? obj.confidence / 100 : 0.7,
              eventAt: created,
              tags: {
                stix_type: type,
                stix_id: obj.id,
                stix_labels: obj.labels,
                stix_pattern: obj.pattern,
                stix_malware_types: obj.malware_types,
                stix_indicator_types: obj.indicator_types,
                stix_source: url,
              },
            },
            sourceId,
          ),
        );
      }
    } catch (err) {
      console.error('[stix] Poll failed:', err instanceof Error ? err.message : String(err));
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const url = String(config.url);
    const start = performance.now();
    try {
      const res = await fetch(url, {
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
