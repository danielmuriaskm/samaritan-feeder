import { BaseAdapter } from './base.js';
import type { RawEvent } from '../types.js';

export class HibpAdapter extends BaseAdapter {
  readonly kind = 'hibp' as const;
  readonly name = 'Have I Been Pwned (Breach Data)';

  validate(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      errors.push('config.apiKey is required');
    }
    const hasDomain = typeof config.domain === 'string' && config.domain.length > 0;
    const hasEmail = typeof config.email === 'string' && config.email.length > 0;
    if (!hasDomain && !hasEmail) {
      errors.push('config.domain or config.email is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async poll(config: Record<string, unknown>, cursor?: string): Promise<RawEvent[]> {
    const apiKey = String(config.apiKey);
    const domain = typeof config.domain === 'string' ? String(config.domain).trim().toLowerCase() : undefined;
    const email = typeof config.email === 'string' ? String(config.email).trim().toLowerCase() : undefined;
    const sourceId = String(config.sourceId ?? `hibp_${domain || email}`);
    const since = cursor ? Number(cursor) : 0;

    let breaches: HibpBreach[] = [];

    if (domain) {
      const url = `https://haveibeenpwned.com/api/v3/breacheddomain/${encodeURIComponent(domain)}`;
      const res = await fetch(url, {
        headers: { 'hibp-api-key': apiKey, 'User-Agent': 'Samaritan-Feeder' },
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 404) {
        return []; // No breaches found
      }
      if (!res.ok) {
        throw new Error(`HIBP domain lookup failed: ${res.status} ${res.statusText}`);
      }

      const emails = (await res.json()) as Record<string, string[]>;
      // emails = { "alice@example.com": ["Breach1", "Breach2"], ... }
      for (const [addr, breachNames] of Object.entries(emails)) {
        for (const name of breachNames) {
          breaches.push({
            Name: name,
            email: addr,
            queryType: 'domain',
            queryValue: domain,
          });
        }
      }
    } else if (email) {
      const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}`;
      const res = await fetch(url, {
        headers: { 'hibp-api-key': apiKey, 'User-Agent': 'Samaritan-Feeder' },
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 404) {
        return [];
      }
      if (!res.ok) {
        throw new Error(`HIBP account lookup failed: ${res.status} ${res.statusText}`);
      }

      const accountBreaches = (await res.json()) as Array<{ Name: string }>;
      for (const b of accountBreaches) {
        breaches.push({
          Name: b.Name,
          email,
          queryType: 'email',
          queryValue: email,
        });
      }
    }

    const events: RawEvent[] = [];
    for (const breach of breaches) {
      // Fetch full breach details
      const detailRes = await fetch(`https://haveibeenpwned.com/api/v3/breach/${encodeURIComponent(breach.Name)}`, {
        headers: { 'hibp-api-key': apiKey, 'User-Agent': 'Samaritan-Feeder' },
        signal: AbortSignal.timeout(15000),
      });

      let details: HibpBreachDetail | undefined;
      if (detailRes.ok) {
        details = (await detailRes.json()) as HibpBreachDetail;
      }

      const eventAt = details?.BreachDate ? new Date(details.BreachDate).getTime() : Date.now();
      if (eventAt <= since) continue;

      events.push(
        this.makeEvent(
          {
            kind: 'alert',
            title: `Breach: ${breach.Name}`,
            content: [
              `Breach: ${breach.Name}`,
              `Affected: ${breach.email}`,
              details?.Description ? `Description: ${this.stripHtml(details.Description)}` : '',
              details?.BreachDate ? `Breach Date: ${details.BreachDate}` : '',
              details?.AddedDate ? `Added to HIBP: ${details.AddedDate}` : '',
              details?.DataClasses ? `Data Types: ${details.DataClasses.join(', ')}` : '',
              details?.PwnCount ? `Accounts Affected: ${details.PwnCount.toLocaleString()}` : '',
              details?.IsVerified ? 'Verified: yes' : '',
              details?.IsFabricated ? 'Fabricated: yes' : '',
              details?.IsSensitive ? 'Sensitive: yes' : '',
            ]
              .filter(Boolean)
              .join('\n'),
            rawData: { breach, details } as unknown as Record<string, unknown>,
            eventAt,
            confidence: details?.IsVerified ? 0.95 : 0.7,
            tags: {
              breach_name: breach.Name,
              email: breach.email,
              query_type: breach.queryType,
              query_value: breach.queryValue,
              breach_date: details?.BreachDate,
              pwn_count: details?.PwnCount,
              data_classes: details?.DataClasses,
              is_verified: details?.IsVerified,
              is_sensitive: details?.IsSensitive,
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
    const url = 'https://haveibeenpwned.com/api/v3/breaches';
    const start = performance.now();
    try {
      const res = await fetch(url, {
        headers: { 'hibp-api-key': apiKey, 'User-Agent': 'Samaritan-Feeder' },
        signal: AbortSignal.timeout(10000),
      });
      return { healthy: res.ok, latencyMs: Math.round(performance.now() - start) };
    } catch {
      return { healthy: false, latencyMs: Math.round(performance.now() - start) };
    }
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

interface HibpBreach {
  Name: string;
  email: string;
  queryType: string;
  queryValue: string;
}

interface HibpBreachDetail {
  Name?: string;
  Description?: string;
  BreachDate?: string;
  AddedDate?: string;
  DataClasses?: string[];
  PwnCount?: number;
  IsVerified?: boolean;
  IsFabricated?: boolean;
  IsSensitive?: boolean;
}
