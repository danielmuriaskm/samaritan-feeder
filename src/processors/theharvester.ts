import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

/**
 * TheHarvester-style multi-source email/host/domain collection.
 * Queries Google, Bing, and DNS for emails, hosts, and subdomains
 * associated with a target domain.
 */
export async function runTheHarvester(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_DOMAIN_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const domains = extractDomains(event);
  if (domains.length === 0) return;

  for (const domain of domains) {
    await harvestDomain(domain, event.id);
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

async function harvestDomain(domain: string, parentEventId: string): Promise<void> {
  const emails: string[] = [];
  const hosts: string[] = [];
  const subdomains: string[] = [];

  // 1. Bing web search for emails and subdomains
  try {
    const bingEmails = await searchBing(domain);
    emails.push(...bingEmails.emails);
    hosts.push(...bingEmails.hosts);
  } catch {
    // ignore
  }

  // 2. DNS brute-force for subdomains (lightweight)
  try {
    const dnsSubs = await bruteForceSubdomains(domain);
    subdomains.push(...dnsSubs);
  } catch {
    // ignore
  }

  // 3. Query GitHub for exposed emails in commits (public search)
  try {
    const ghEmails = await searchGitHubEmails(domain);
    emails.push(...ghEmails);
  } catch {
    // ignore
  }

  const seenEmails = [...new Set(emails)];
  const seenHosts = [...new Set(hosts)];
  const seenSubs = [...new Set(subdomains)];

  if (seenEmails.length > 0) {
    await createReconEvent({
      title: `TheHarvester: emails for ${domain}`,
      content: `Discovered emails associated with ${domain}:\n${seenEmails.slice(0, 30).map((e) => `- ${e}`).join('\n')}`,
      tags: {
        recon_source: 'theharvester',
        recon_type: 'emails',
        parent_event_id: parentEventId,
        domain,
        emails: seenEmails,
      },
    });
    reconHourlyCount++;
  }

  if (seenHosts.length > 0) {
    await createReconEvent({
      title: `TheHarvester: hosts for ${domain}`,
      content: `Discovered hosts associated with ${domain}:\n${seenHosts.slice(0, 30).map((h) => `- ${h}`).join('\n')}`,
      tags: {
        recon_source: 'theharvester',
        recon_type: 'hosts',
        parent_event_id: parentEventId,
        domain,
        hosts: seenHosts,
      },
    });
    reconHourlyCount++;
  }

  if (seenSubs.length > 0) {
    await createReconEvent({
      title: `TheHarvester: subdomains for ${domain}`,
      content: `Discovered subdomains for ${domain}:\n${seenSubs.slice(0, 30).map((s) => `- ${s}`).join('\n')}`,
      tags: {
        recon_source: 'theharvester',
        recon_type: 'subdomains',
        parent_event_id: parentEventId,
        domain,
        subdomains: seenSubs,
      },
    });
    reconHourlyCount++;
  }
}

async function searchBing(domain: string): Promise<{ emails: string[]; hosts: string[] }> {
  const emails: string[] = [];
  const hosts: string[] = [];

  // Use Bing's web search via a simple scrape of their results page
  // This is best-effort and may break if Bing changes their HTML
  const query = `site:${domain} "@"`;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=30`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return { emails, hosts };
    const html = await res.text();

    // Extract emails
    const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
    const emailMatches = html.matchAll(emailRegex);
    for (const m of emailMatches) {
      const email = m[0].toLowerCase();
      if (email.endsWith(`@${domain}`) || email.endsWith(`.${domain}`)) {
        emails.push(email);
      }
    }

    // Extract subdomains from URLs
    const urlRegex = new RegExp(`https?://([a-zA-Z0-9.-]+\\.${domain.replace(/\./g, '\\.')})`, 'g');
    const urlMatches = html.matchAll(urlRegex);
    for (const m of urlMatches) {
      hosts.push(m[1].toLowerCase());
    }
  } catch {
    // ignore
  }

  return { emails: [...new Set(emails)], hosts: [...new Set(hosts)] };
}

async function bruteForceSubdomains(domain: string): Promise<string[]> {
  const found: string[] = [];
  const words = ['www', 'mail', 'api', 'ftp', 'blog', 'shop', 'dev', 'vpn', 'admin', 'portal', 'remote'];

  for (const word of words) {
    const sub = `${word}.${domain}`;
    try {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(sub)}&type=A`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { Answer?: Array<{ data: string }> };
      if (data.Answer?.[0]?.data) {
        found.push(sub);
      }
    } catch {
      // ignore
    }
  }

  return found;
}

async function searchGitHubEmails(domain: string): Promise<string[]> {
  const emails: string[] = [];
  try {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(`@${domain}`)}&per_page=10`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Samaritan-Feeder/1.0',
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return emails;

    const data = (await res.json()) as { items?: Array<{ html_url: string }> };
    for (const item of data.items ?? []) {
      // Try to fetch raw content for email extraction
      const rawUrl = item.html_url.replace('/blob/', '/raw/');
      try {
        const rawRes = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) });
        if (!rawRes.ok) continue;
        const text = await rawRes.text();
        const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
        const matches = text.matchAll(emailRegex);
        for (const m of matches) {
          const email = m[0].toLowerCase();
          if (email.endsWith(`@${domain}`)) {
            emails.push(email);
          }
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return [...new Set(emails)];
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
      'recon_theharvester',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.75,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
