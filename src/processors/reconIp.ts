import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

export async function runIpEnrichment(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_IP_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const ips = extractIpsFromEvent(event);
  if (ips.length === 0) return;

  for (const ip of ips) {
    await enrichIp(ip, event.id);
  }
}

function extractIpsFromEvent(event: IntelligenceEvent): string[] {
  const ips: string[] = [];
  const tags = event.tags;

  if (typeof tags.ip === 'string') ips.push(tags.ip);
  if (Array.isArray(tags.ips)) {
    for (const ip of tags.ips) {
      if (typeof ip === 'string') ips.push(ip);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && (e.type === 'ipv4' || e.type === 'ipv6') && typeof e.value === 'string') {
        ips.push(e.value);
      }
    }
  }

  return [...new Set(ips)];
}

async function enrichIp(ip: string, parentEventId: string): Promise<void> {
  try {
    // 1. IP geolocation via ip-api.com (free, no key)
    const geo = await queryIpGeo(ip);
    let metadata: Record<string, unknown> = {};

    if (geo) {
      metadata = {
        country: geo.country,
        countryCode: geo.countryCode,
        region: geo.regionName,
        city: geo.city,
        zip: geo.zip,
        lat: geo.lat,
        lon: geo.lon,
        timezone: geo.timezone,
        isp: geo.isp,
        org: geo.org,
        as: geo.as,
      };
    }

    // 2. Shodan enrichment (if API key available)
    let shodanData: Record<string, unknown> | undefined;
    if (config.SHODAN_API_KEY) {
      shodanData = await queryShodan(ip);
      if (shodanData) {
        metadata = { ...metadata, shodan: shodanData };
      }
    }

    // Update entity metadata if entity exists
    await exec(
      `UPDATE intelligence_entities
       SET metadata = metadata || $1::jsonb
       WHERE type IN ('ipv4', 'ipv6') AND value = $2`,
      [JSON.stringify(metadata), ip],
    );

    // Create alert if Shodan found open ports or CVEs
    if (shodanData && (shodanData.ports || shodanData.vulns)) {
      const ports = Array.isArray(shodanData.ports) ? shodanData.ports : [];
      const vulns = shodanData.vulns ? Object.keys(shodanData.vulns as Record<string, unknown>) : [];

      await createReconEvent({
        title: `Recon: IP ${ip} enrichment`,
        content: [
          `IP: ${ip}`,
          geo ? `Location: ${geo.city}, ${geo.country}` : '',
          geo ? `ISP: ${geo.isp}` : '',
          ports.length ? `Open ports: ${ports.join(', ')}` : '',
          vulns.length ? `CVEs: ${vulns.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        tags: {
          recon_source: 'ip',
          recon_type: 'enrichment',
          parent_event_id: parentEventId,
          ip,
          ...metadata,
        },
        location: geo?.lat && geo?.lon ? { lat: geo.lat, lon: geo.lon } : undefined,
      });
      reconHourlyCount++;
    }
  } catch (err) {
    console.error(`[reconIp] Failed for ${ip}:`, err instanceof Error ? err.message : String(err));
  }
}

async function queryIpGeo(ip: string): Promise<{ country: string; countryCode: string; regionName: string; city: string; zip: string; lat: number; lon: number; timezone: string; isp: string; org: string; as: string } | undefined> {
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { status: string } & Record<string, unknown>;
    if (data.status !== 'success') return undefined;
    return data as unknown as { country: string; countryCode: string; regionName: string; city: string; zip: string; lat: number; lon: number; timezone: string; isp: string; org: string; as: string };
  } catch {
    return undefined;
  }
}

async function queryShodan(ip: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(config.SHODAN_API_KEY!)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      ports: data.ports,
      vulns: data.vulns,
      hostnames: data.hostnames,
      isp: data.isp,
      org: data.org,
      os: data.os,
    };
  } catch {
    return undefined;
  }
}

async function createReconEvent(partial: {
  title: string;
  content: string;
  tags: Record<string, unknown>;
  location?: { lat: number; lon: number };
}): Promise<void> {
  const id = `recon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await exec(
    `INSERT INTO intelligence_events
     (id, source_id, kind, title, content, tags, confidence, sensitivity, location_lat, location_lon, event_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      'recon_ip',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.75,
      'public',
      partial.location?.lat ?? null,
      partial.location?.lon ?? null,
      Date.now(),
      Date.now(),
    ],
  );
}
