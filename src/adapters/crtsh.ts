import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class CrtshAdapter extends BaseAdapter {
  readonly kind = 'crtsh' as const;
  readonly name = 'crt.sh (Certificate Transparency)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.domain !== 'string' || config.domain.length === 0) {
      errors.push('config.domain is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const domain = String(config.domain).trim().toLowerCase();
    const sourceId = String(config.sourceId ?? `crtsh_${domain.replace(/[^a-z0-9_-]/g, '_')}`);
    const since = cursor ? Number(cursor) : 0;

    const url = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      throw new Error(`crt.sh fetch failed: ${res.status} ${res.statusText}`);
    }

    const entries = (await res.json()) as CrtEntry[];
    if (!Array.isArray(entries)) {
      throw new Error('crt.sh returned unexpected format');
    }

    // Deduplicate by name_value and filter wildcards for cleaner output
    const seen = new Set<string>();
    const uniqueEntries: CrtEntry[] = [];
    for (const e of entries) {
      const name = String(e.name_value).trim().toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      uniqueEntries.push(e);
    }

    const events: RawEvent[] = [];
    for (const entry of uniqueEntries) {
      const eventAt = entry.entry_timestamp ? new Date(entry.entry_timestamp).getTime() : Date.now();
      if (eventAt <= since) continue;

      const name = String(entry.name_value).trim();
      const isWildcard = name.startsWith('*.');
      const cleanName = isWildcard ? name.slice(2) : name;

      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Certificate: ${name}`,
            content: [
              `Domain: ${name}`,
              `Issuer: ${entry.issuer_name || 'unknown'}`,
              `Entry ID: ${entry.id}`,
              `Logged At: ${entry.entry_timestamp || 'unknown'}`,
              `Not Before: ${entry.not_before || 'unknown'}`,
              `Not After: ${entry.not_after || 'unknown'}`,
            ].join('\n'),
            rawData: entry as unknown as Record<string, unknown>,
            eventAt,
            confidence: 0.85,
            tags: {
              domain: cleanName,
              wildcard: isWildcard,
              issuer: entry.issuer_name,
              cert_id: entry.id,
              not_before: entry.not_before,
              not_after: entry.not_after,
              parent_domain: domain,
            },
          },
          sourceId,
        ),
      );
    }

    return events;
  }

  async health(config: Record<string, unknown>): Promise<{ healthy: boolean; latencyMs: number }> {
    const domain = String(config.domain || 'google.com');
    const url = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;
    const start = performance.now();
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}

interface CrtEntry {
  id?: number;
  issuer_name?: string;
  name_value?: string;
  entry_timestamp?: string;
  not_before?: string;
  not_after?: string;
}
