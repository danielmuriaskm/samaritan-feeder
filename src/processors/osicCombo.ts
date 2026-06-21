import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

export async function runOsicCombo(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_OSIC_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const targets = extractTargets(event);
  if (targets.length === 0) return;

  for (const target of targets) {
    await enrichOsic(target, event.id);
  }
}

function extractTargets(event: IntelligenceEvent): Array<{ type: 'ip' | 'domain'; value: string }> {
  const targets: Array<{ type: 'ip' | 'domain'; value: string }> = [];
  const tags = event.tags;

  if (typeof tags.ip === 'string') targets.push({ type: 'ip', value: tags.ip });
  if (typeof tags.domain === 'string') targets.push({ type: 'domain', value: tags.domain });

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!e || typeof e !== 'object') continue;
      if ((e.type === 'ipv4' || e.type === 'ipv6') && typeof e.value === 'string') {
        targets.push({ type: 'ip', value: e.value });
      }
      if (e.type === 'domain' && typeof e.value === 'string') {
        targets.push({ type: 'domain', value: e.value });
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

async function enrichOsic(target: { type: 'ip' | 'domain'; value: string }, parentEventId: string): Promise<void> {
  try {
    const [geo, whois, ptr, shodan] = await Promise.allSettled([
      target.type === 'ip' ? queryGeo(target.value) : Promise.resolve(undefined),
      queryWhois(target.value),
      target.type === 'ip' ? queryReverseDns(target.value) : Promise.resolve(undefined),
      target.type === 'ip' && config.SHODAN_API_KEY ? queryShodan(target.value) : Promise.resolve(undefined),
    ]);

    const geoData = geo.status === 'fulfilled' ? geo.value : undefined;
    const whoisData = whois.status === 'fulfilled' ? whois.value : undefined;
    const ptrData = ptr.status === 'fulfilled' ? ptr.value : undefined;
    const shodanData = shodan.status === 'fulfilled' ? shodan.value : undefined;

    const lines: string[] = [`OSIC unified intel for ${target.type}: ${target.value}`];

    if (geoData) {
      lines.push(`\n[GeoIP]`);
      lines.push(`Country: ${geoData.country} (${geoData.countryCode})`);
      lines.push(`City: ${geoData.city}, ${geoData.region}`);
      lines.push(`ISP: ${geoData.isp}`);
      lines.push(`ASN: ${geoData.as}`);
      lines.push(`Coords: ${geoData.lat}, ${geoData.lon}`);
    }

    if (whoisData) {
      lines.push(`\n[WHOIS]`);
      if (whoisData.registrar) lines.push(`Registrar: ${whoisData.registrar}`);
      if (whoisData.created) lines.push(`Created: ${whoisData.created}`);
      if (whoisData.expires) lines.push(`Expires: ${whoisData.expires}`);
      if (whoisData.nameservers?.length) lines.push(`NS: ${whoisData.nameservers.join(', ')}`);
      if (whoisData.org) lines.push(`Org: ${whoisData.org}`);
    }

    if (ptrData) {
      lines.push(`\n[Reverse DNS]`);
      lines.push(`Hostname: ${ptrData}`);
    }

    if (shodanData) {
      lines.push(`\n[Shodan]`);
      if (shodanData.ports?.length) lines.push(`Ports: ${shodanData.ports.join(', ')}`);
      if (shodanData.hostnames?.length) lines.push(`Hostnames: ${shodanData.hostnames.join(', ')}`);
      if (shodanData.os) lines.push(`OS: ${shodanData.os}`);
      if (shodanData.vulns?.length) lines.push(`CVEs: ${shodanData.vulns.join(', ')}`);
    }

    await createReconEvent({
      title: `OSIC: ${target.value}`,
      content: lines.join('\n'),
      tags: {
        recon_source: 'osic',
        recon_type: 'osic_combo',
        parent_event_id: parentEventId,
        target_type: target.type,
        target_value: target.value,
        osic_geo: geoData,
        osic_whois: whoisData,
        osic_ptr: ptrData,
        osic_shodan: shodanData,
      },
    });
    reconHourlyCount++;
  } catch (err) {
    console.error(`[osicCombo] Failed for ${target.value}:`, err instanceof Error ? err.message : String(err));
  }
}

async function queryGeo(ip: string): Promise<
  { country: string; countryCode: string; region: string; city: string; isp: string; as: string; lat: number; lon: number } | undefined
> {
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,lat,lon,isp,as`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { status: string } & Record<string, unknown>;
    if (data.status !== 'success') return undefined;
    return {
      country: String(data.country),
      countryCode: String(data.countryCode),
      region: String(data.regionName),
      city: String(data.city),
      isp: String(data.isp),
      as: String(data.as),
      lat: Number(data.lat),
      lon: Number(data.lon),
    };
  } catch {
    return undefined;
  }
}

async function queryWhois(target: string): Promise<
  { registrar?: string; created?: string; expires?: string; nameservers?: string[]; org?: string } | undefined
> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(target)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    if (data.success === false) return undefined;
    return {
      registrar: typeof data['domain registrar'] === 'string' ? (data['domain registrar'] as string) : undefined,
      created: typeof data.creation_date === 'string' ? data.creation_date : undefined,
      expires: typeof data.expiration_date === 'string' ? data.expiration_date : undefined,
      nameservers: Array.isArray(data.name_servers)
        ? (data.name_servers as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
      org: typeof data.org === 'string' ? data.org : undefined,
    };
  } catch {
    return undefined;
  }
}

async function queryReverseDns(ip: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(ip.split('.').reverse().join('.'))}.in-addr.arpa&type=PTR`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { Answer?: Array<{ data: string }> };
    return data.Answer?.[0]?.data;
  } catch {
    return undefined;
  }
}

async function queryShodan(ip: string): Promise<
  { ports?: number[]; hostnames?: string[]; os?: string; vulns?: string[] } | undefined
> {
  if (!config.SHODAN_API_KEY) return undefined;
  try {
    const res = await fetch(
      `https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(config.SHODAN_API_KEY)}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      ports: Array.isArray(data.ports) ? (data.ports as number[]) : undefined,
      hostnames: Array.isArray(data.hostnames) ? (data.hostnames as string[]) : undefined,
      os: typeof data.os === 'string' ? data.os : undefined,
      vulns: data.vulns ? Object.keys(data.vulns as Record<string, unknown>) : undefined,
    };
  } catch {
    return undefined;
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
      'recon_osic',
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
