import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

/**
 * PassiveTotal-style passive DNS and WHOIS enrichment via RiskIQ API.
 * Requires PASSIVETOTAL_API_KEY and PASSIVETOTAL_USERNAME config.
 */
export async function runPassiveTotal(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_DOMAIN_ENABLED || !config.PASSIVETOTAL_API_KEY || !config.PASSIVETOTAL_USERNAME) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const targets = extractTargets(event);
  if (targets.length === 0) return;

  for (const target of targets) {
    await enrichPassiveTotal(target, event.id);
  }
}

function extractTargets(event: IntelligenceEvent): Array<{ type: 'domain' | 'ip'; value: string }> {
  const targets: Array<{ type: 'domain' | 'ip'; value: string }> = [];
  const tags = event.tags;

  if (typeof tags.domain === 'string') targets.push({ type: 'domain', value: tags.domain });
  if (typeof tags.ip === 'string') targets.push({ type: 'ip', value: tags.ip });

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'domain' && typeof e.value === 'string') {
        targets.push({ type: 'domain', value: e.value });
      }
      if ((e.type === 'ipv4' || e.type === 'ipv6') && typeof e.value === 'string') {
        targets.push({ type: 'ip', value: e.value });
      }
    }
  }

  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.type}:${t.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichPassiveTotal(target: { type: string; value: string }, parentEventId: string): Promise<void> {
  try {
    const auth = Buffer.from(`${config.PASSIVETOTAL_USERNAME}:${config.PASSIVETOTAL_API_KEY}`).toString('base64');
    const headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    };

    // 1. Passive DNS
    const [dnsResult, whoisResult] = await Promise.allSettled([
      queryPassiveDNS(target.value, headers),
      queryWhois(target.value, headers),
    ]);

    const dns = dnsResult.status === 'fulfilled' ? dnsResult.value : null;
    const whois = whoisResult.status === 'fulfilled' ? whoisResult.value : null;

    if (!dns && !whois) return;

    const lines: string[] = [`PassiveTotal intel for ${target.type}: ${target.value}`];

    if (dns && dns.length > 0) {
      lines.push(`\n[Passive DNS]`);
      for (const r of dns.slice(0, 15)) {
        lines.push(`- ${r.resolveType}: ${r.resolveValue} (first: ${r.firstSeen}, last: ${r.lastSeen})`);
      }
    }

    if (whois) {
      lines.push(`\n[WHOIS]`);
      if (whois.registrar) lines.push(`Registrar: ${whois.registrar}`);
      if (whois.organization) lines.push(`Organization: ${whois.organization}`);
      if (whois.nameServers?.length) lines.push(`Name Servers: ${whois.nameServers.join(', ')}`);
      if (whois.contactEmail) lines.push(`Contact Email: ${whois.contactEmail}`);
      if (whois.registrant) lines.push(`Registrant: ${whois.registrant}`);
    }

    await createReconEvent({
      title: `PassiveTotal: ${target.value}`,
      content: lines.join('\n'),
      tags: {
        recon_source: 'passivetotal',
        recon_type: 'passive_intel',
        parent_event_id: parentEventId,
        target_type: target.type,
        target_value: target.value,
        passivetotal_dns: dns?.slice(0, 15),
        passivetotal_whois: whois,
      },
    });
    reconHourlyCount++;
  } catch (err) {
    console.error(`[passivetotal] Failed for ${target.value}:`, err instanceof Error ? err.message : String(err));
  }
}

async function queryPassiveDNS(
  query: string,
  headers: Record<string, string>,
): Promise<Array<{ resolveType: string; resolveValue: string; firstSeen: string; lastSeen: string }> | null> {
  try {
    const res = await fetch(`https://api.passivetotal.org/v2/dns/passive?query=${encodeURIComponent(query)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{
        resolveType?: string;
        resolveValue?: string;
        firstSeen?: string;
        lastSeen?: string;
      }>;
    };
    return (data.results ?? []).map((r) => ({
      resolveType: r.resolveType ?? 'A',
      resolveValue: r.resolveValue ?? '',
      firstSeen: r.firstSeen ?? 'unknown',
      lastSeen: r.lastSeen ?? 'unknown',
    }));
  } catch {
    return null;
  }
}

async function queryWhois(
  query: string,
  headers: Record<string, string>,
): Promise<
  | {
      registrar?: string;
      organization?: string;
      nameServers?: string[];
      contactEmail?: string;
      registrant?: string;
    }
  | null
> {
  try {
    const res = await fetch(`https://api.passivetotal.org/v2/whois?query=${encodeURIComponent(query)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      registrar?: string;
      organization?: string;
      nameServers?: string[];
      contactEmail?: string;
      registrant?: string;
    };
    return {
      registrar: data.registrar,
      organization: data.organization,
      nameServers: Array.isArray(data.nameServers) ? data.nameServers : undefined,
      contactEmail: data.contactEmail,
      registrant: data.registrant,
    };
  } catch {
    return null;
  }
}

async function createReconEvent(partial: {
  title: string;
  content: string;
  tags: Record<string, unknown>;
}): Promise<void> {
  const id = `recon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await exec(
    `INSERT INTO intelligence_events
     (id, source_id, kind, title, content, tags, confidence, sensitivity, event_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      'recon_passivetotal',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.8,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
