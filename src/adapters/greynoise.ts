import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';
import { config } from '../config.js';

export class GreynoiseAdapter extends BaseAdapter {
  readonly kind = 'greynoise' as const;
  readonly name = 'GreyNoise (IP Noise Intel)';

  validate(cfg: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof cfg.query !== 'string' || !cfg.query.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      errors.push('query must be a valid IPv4 address');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(cfg: Record<string, unknown>): Promise<RawEvent[]> {
    const ip = String(cfg.query);
    const sourceId = this.slugify(String(cfg.sourceId || ip));

    try {
      const url = `https://api.greynoise.io/v3/community/${ip}`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (config.GREYNOISE_API_KEY) {
        headers['key'] = config.GREYNOISE_API_KEY;
      }

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        if (res.status === 404) {
          // IP not seen by GreyNoise — emit a clean result
          return [];
        }
        throw new Error(`GreyNoise API returned ${res.status}`);
      }

      const data = (await res.json()) as {
        ip?: string;
        noise?: boolean;
        riot?: boolean;
        classification?: string;
        name?: string;
        link?: string;
        last_seen?: string;
        message?: string;
      };

      if (data.message === 'IP not observed scanning the internet or contained in RIOT data.') {
        return [];
      }

      const contentLines = [
        `IP: ${data.ip}`,
        `Noise: ${data.noise ? 'yes' : 'no'}`,
        `RIOT: ${data.riot ? 'yes' : 'no'}`,
        data.classification ? `Classification: ${data.classification}` : '',
        data.name ? `Actor: ${data.name}` : '',
        data.last_seen ? `Last seen: ${data.last_seen}` : '',
        data.link ? `More info: ${data.link}` : '',
      ].filter(Boolean);

      return [
        this.makeEvent(
          {
            kind: 'alert',
            title: `GreyNoise: ${ip}`,
            content: contentLines.join('\n'),
            confidence: data.classification === 'malicious' ? 0.9 : 0.7,
            eventAt: Date.now(),
            tags: {
              greynoise_ip: data.ip,
              greynoise_noise: data.noise,
              greynoise_riot: data.riot,
              greynoise_classification: data.classification,
              greynoise_actor: data.name,
              greynoise_link: data.link,
            },
          },
          sourceId,
        ),
      ];
    } catch (err) {
      console.error('[greynoise] Poll failed:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (config.GREYNOISE_API_KEY) headers['key'] = config.GREYNOISE_API_KEY;
      const res = await fetch('https://api.greynoise.io/v3/community/8.8.8.8', {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok || res.status === 404, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private slugify(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }
}
