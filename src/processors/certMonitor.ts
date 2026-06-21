import { config } from '../config.js';
import { exec, one } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

export async function runCertMonitor(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_CERT_MONITOR_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const domains = extractDomains(event);
  if (domains.length === 0) return;

  for (const domain of domains) {
    await monitorDomain(domain, event.id);
  }
}

function extractDomains(event: IntelligenceEvent): string[] {
  const domains: string[] = [];
  const tags = event.tags;

  if (typeof tags.domain === 'string') domains.push(tags.domain);
  if (Array.isArray(tags.domains)) {
    for (const d of tags.domains) {
      if (typeof d === 'string') domains.push(d);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && e.type === 'domain' && typeof e.value === 'string') {
        domains.push(e.value);
      }
    }
  }

  return [...new Set(domains)];
}

async function monitorDomain(domain: string, parentEventId: string): Promise<void> {
  try {
    const currentSubs = await queryCrtsh(domain);
    if (currentSubs.length === 0) return;

    // Get stored subdomains from entity metadata
    const entity = await one<{ id: string; metadata: string }>(
      `SELECT id, metadata FROM intelligence_entities WHERE type = 'domain' AND value = $1`,
      [domain],
    );

    let seenSubdomains: string[] = [];
    if (entity && entity.metadata) {
      try {
        const meta = JSON.parse(entity.metadata) as Record<string, unknown>;
        const stored = meta.cert_seen_subdomains;
        if (Array.isArray(stored)) {
          seenSubdomains = stored.filter((s): s is string => typeof s === 'string');
        }
      } catch {
        // ignore parse errors
      }
    }

    const newSubs = currentSubs.filter((s) => !seenSubdomains.includes(s));

    if (newSubs.length > 0) {
      // Update stored list
      const updated = [...new Set([...seenSubdomains, ...currentSubs])];
      await exec(
        `UPDATE intelligence_entities
         SET metadata = metadata || $1::jsonb, last_seen_at = $2
         WHERE type = 'domain' AND value = $3`,
        [JSON.stringify({ cert_seen_subdomains: updated }), Date.now(), domain],
      );

      for (const sub of newSubs) {
        await createReconEvent({
          title: `New subdomain: ${sub}`,
          content: `New subdomain discovered via certificate transparency monitor:\nDomain: ${domain}\nSubdomain: ${sub}\nPreviously known: ${seenSubdomains.length}`,
          tags: {
            recon_source: 'cert_monitor',
            recon_type: 'new_subdomain',
            parent_event_id: parentEventId,
            domain,
            subdomain: sub,
            is_new: true,
            known_count: seenSubdomains.length,
          },
        });
        reconHourlyCount++;
      }
    }
  } catch (err) {
    console.error(`[certMonitor] Failed for ${domain}:`, err instanceof Error ? err.message : String(err));
  }
}

async function queryCrtsh(domain: string): Promise<string[]> {
  try {
    const url = `https://crt.sh/?q=%.${encodeURIComponent(domain)}&output=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];

    const entries = (await res.json()) as Array<{ name_value?: string }>;
    if (!Array.isArray(entries)) return [];

    const seen = new Set<string>();
    const results: string[] = [];
    for (const e of entries) {
      const name = String(e.name_value).trim().toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      if (name.startsWith('*.')) continue;
      if (name === domain) continue;
      results.push(name);
    }
    return results.slice(0, 100);
  } catch {
    return [];
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
      'recon_cert_monitor',
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
