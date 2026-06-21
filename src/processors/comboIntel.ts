import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

export async function runComboIntel(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_COMBO_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const targets = extractTargets(event);
  if (targets.length === 0) return;

  for (const target of targets) {
    await enrichCombo(target, event.id);
  }
}

function extractTargets(event: IntelligenceEvent): Array<{ type: 'ip' | 'domain' | 'url'; value: string }> {
  const targets: Array<{ type: 'ip' | 'domain' | 'url'; value: string }> = [];
  const tags = event.tags;

  if (typeof tags.ip === 'string') targets.push({ type: 'ip', value: tags.ip });
  if (typeof tags.domain === 'string') targets.push({ type: 'domain', value: tags.domain });
  if (typeof tags.url === 'string') targets.push({ type: 'url', value: tags.url });

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'ipv4' || e.type === 'ipv6') targets.push({ type: 'ip', value: e.value });
      if (e.type === 'domain') targets.push({ type: 'domain', value: e.value });
      if (e.type === 'url') targets.push({ type: 'url', value: e.value });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.type}:${t.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichCombo(target: { type: string; value: string }, parentEventId: string): Promise<void> {
  try {
    const [vtResult, shodanResult, dnsResult] = await Promise.allSettled([
      queryVirusTotal(target),
      config.SHODAN_API_KEY ? queryShodan(target) : Promise.resolve(undefined),
      target.type !== 'url' ? queryPassiveDns(target.value) : Promise.resolve([]),
    ]);

    const vt = vtResult.status === 'fulfilled' ? vtResult.value : undefined;
    const shodan = shodanResult.status === 'fulfilled' ? shodanResult.value : undefined;
    const dns = dnsResult.status === 'fulfilled' ? dnsResult.value : [];

    const sources: string[] = [];
    const lines: string[] = [`Combo intel for ${target.type}: ${target.value}`];

    if (vt) {
      sources.push('virustotal');
      lines.push(`\n[VirusTotal]`);
      if (vt.malicious) lines.push(`Malicious: ${vt.malicious} engines flagged`);
      if (vt.suspicious) lines.push(`Suspicious: ${vt.suspicious} engines flagged`);
      if (vt.harmless) lines.push(`Clean: ${vt.harmless} engines`);
      if (vt.reputation !== undefined) lines.push(`Reputation: ${vt.reputation}`);
    }

    if (shodan) {
      sources.push('shodan');
      lines.push(`\n[Shodan]`);
      if (shodan.ports?.length) lines.push(`Open ports: ${shodan.ports.join(', ')}`);
      if (shodan.hostnames?.length) lines.push(`Hostnames: ${shodan.hostnames.join(', ')}`);
      if (shodan.os) lines.push(`OS: ${shodan.os}`);
      if (shodan.vulns?.length) lines.push(`CVEs: ${shodan.vulns.join(', ')}`);
    }

    if (dns.length) {
      sources.push('passivedns');
      lines.push(`\n[PassiveDNS]`);
      for (const r of dns.slice(0, 10)) {
        lines.push(`${r.type}: ${r.value}`);
      }
    }

    if (sources.length === 0) return;

    await createReconEvent({
      title: `Combo Intel: ${target.value}`,
      content: lines.join('\n'),
      tags: {
        recon_source: 'combo',
        recon_type: 'combo_intel',
        parent_event_id: parentEventId,
        target_type: target.type,
        target_value: target.value,
        combo_sources: sources,
        vt_malicious: vt?.malicious,
        vt_suspicious: vt?.suspicious,
        shodan_ports: shodan?.ports,
        shodan_vulns: shodan?.vulns,
        passivedns_records: dns.slice(0, 10),
      },
    });
    reconHourlyCount++;
  } catch (err) {
    console.error(`[comboIntel] Failed for ${target.value}:`, err instanceof Error ? err.message : String(err));
  }
}

async function queryVirusTotal(target: { type: string; value: string }): Promise<
  { malicious?: number; suspicious?: number; harmless?: number; reputation?: number } | undefined
> {
  if (!config.VIRUSTOTAL_API_KEY) return undefined;
  try {
    let endpoint: string;
    if (target.type === 'ip') endpoint = `https://www.virustotal.com/api/v3/ip_addresses/${encodeURIComponent(target.value)}`;
    else if (target.type === 'domain') endpoint = `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(target.value)}`;
    else endpoint = `https://www.virustotal.com/api/v3/urls/${btoa(target.value).replace(/=/g, '')}`;

    const res = await fetch(endpoint, {
      headers: { 'x-apikey': config.VIRUSTOTAL_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      data?: {
        attributes?: {
          last_analysis_stats?: { malicious?: number; suspicious?: number; harmless?: number };
          reputation?: number;
        };
      };
    };
    const attrs = data.data?.attributes;
    if (!attrs) return undefined;
    return {
      malicious: attrs.last_analysis_stats?.malicious,
      suspicious: attrs.last_analysis_stats?.suspicious,
      harmless: attrs.last_analysis_stats?.harmless,
      reputation: attrs.reputation,
    };
  } catch {
    return undefined;
  }
}

async function queryShodan(target: { type: string; value: string }): Promise<
  { ports?: number[]; hostnames?: string[]; os?: string; vulns?: string[] } | undefined
> {
  if (!config.SHODAN_API_KEY || target.type === 'url') return undefined;
  try {
    const res = await fetch(
      `https://api.shodan.io/shodan/host/${encodeURIComponent(target.value)}?key=${encodeURIComponent(config.SHODAN_API_KEY)}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      ports: Array.isArray(data.ports) ? data.ports as number[] : undefined,
      hostnames: Array.isArray(data.hostnames) ? data.hostnames as string[] : undefined,
      os: typeof data.os === 'string' ? data.os : undefined,
      vulns: data.vulns ? Object.keys(data.vulns as Record<string, unknown>) : undefined,
    };
  } catch {
    return undefined;
  }
}

async function queryPassiveDns(value: string): Promise<Array<{ type: string; value: string }>> {
  // Use Google DoH as passive DNS stand-in
  const records: Array<{ type: string; value: string }> = [];
  const types = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME'];
  for (const type of types) {
    try {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(value)}&type=${type}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Answer?: Array<{ data: string; type: number }> };
      for (const ans of data.Answer ?? []) {
        records.push({ type, value: ans.data });
      }
    } catch {
      // ignore
    }
  }
  return records;
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
      'recon_combo',
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
