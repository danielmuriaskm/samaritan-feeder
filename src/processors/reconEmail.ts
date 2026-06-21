import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

// Cache to avoid re-checking same email within 24h
const emailCache = new Map<string, number>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function runEmailBreachCheck(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_EMAIL_ENABLED || !config.HIBP_API_KEY) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const emails = extractEmailsFromEvent(event);
  if (emails.length === 0) return;

  for (const email of emails) {
    const cachedAt = emailCache.get(email);
    if (cachedAt && now - cachedAt < CACHE_TTL_MS) continue;
    emailCache.set(email, now);
    await checkEmailBreach(email, event.id);
  }

  // Also check domain breaches (PwnedOrNot-style)
  const domains = extractDomainsFromEmails(emails);
  for (const domain of domains) {
    await checkDomainBreach(domain, event.id);
  }
}

function extractEmailsFromEvent(event: IntelligenceEvent): string[] {
  const emails: string[] = [];
  const tags = event.tags;

  if (typeof tags.email === 'string') emails.push(tags.email);
  if (Array.isArray(tags.emails)) {
    for (const e of tags.emails) {
      if (typeof e === 'string') emails.push(e);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && e.type === 'email' && typeof e.value === 'string') {
        emails.push(e.value);
      }
    }
  }

  return [...new Set(emails)];
}

function extractDomainsFromEmails(emails: string[]): string[] {
  const domains = new Set<string>();
  for (const email of emails) {
    const parts = email.split('@');
    if (parts.length === 2) domains.add(parts[1].toLowerCase());
  }
  return [...domains];
}

async function checkEmailBreach(email: string, parentEventId: string): Promise<void> {
  try {
    const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      headers: {
        'hibp-api-key': config.HIBP_API_KEY!,
        'User-Agent': 'Samaritan-Feeder',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 404) {
      // No breaches — optionally log a clean result
      return;
    }
    if (!res.ok) {
      console.warn(`[reconEmail] HIBP check failed for ${email}: ${res.status}`);
      return;
    }

    const breaches = (await res.json()) as Array<{ Name: string; Title?: string; BreachDate?: string; DataClasses?: string[]; IsVerified?: boolean; IsSensitive?: boolean; PwnCount?: number }>;

    for (const breach of breaches) {
      await createReconEvent({
        title: `Breach: ${email} in ${breach.Name}`,
        content: [
          `Email: ${email}`,
          `Breach: ${breach.Name}`,
          breach.Title ? `Title: ${breach.Title}` : '',
          breach.BreachDate ? `Breach Date: ${breach.BreachDate}` : '',
          breach.DataClasses ? `Data Types: ${breach.DataClasses.join(', ')}` : '',
          breach.PwnCount ? `Accounts Affected: ${breach.PwnCount.toLocaleString()}` : '',
          breach.IsVerified ? 'Verified: yes' : '',
          breach.IsSensitive ? 'Sensitive: yes' : '',
        ]
          .filter(Boolean)
          .join('\n'),
        tags: {
          recon_source: 'email',
          recon_type: 'breach',
          parent_event_id: parentEventId,
          email,
          breach_name: breach.Name,
          breach_date: breach.BreachDate,
          data_classes: breach.DataClasses,
          is_verified: breach.IsVerified,
          is_sensitive: breach.IsSensitive,
          pwn_count: breach.PwnCount,
        },
      });
      reconHourlyCount++;
    }
  } catch (err) {
    console.error(`[reconEmail] Failed for ${email}:`, err instanceof Error ? err.message : String(err));
  }
}

async function checkDomainBreach(domain: string, parentEventId: string): Promise<void> {
  try {
    const url = `https://haveibeenpwned.com/api/v3/breaches?domain=${encodeURIComponent(domain)}`;
    const res = await fetch(url, {
      headers: {
        'hibp-api-key': config.HIBP_API_KEY!,
        'User-Agent': 'Samaritan-Feeder',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 404) return;
    if (!res.ok) {
      console.warn(`[reconEmail] HIBP domain check failed for ${domain}: ${res.status}`);
      return;
    }

    const breaches = (await res.json()) as Array<{ Name: string; Title?: string; BreachDate?: string; DataClasses?: string[]; IsVerified?: boolean; IsSensitive?: boolean; PwnCount?: number; Domain?: string }>;

    for (const breach of breaches) {
      await createReconEvent({
        title: `Domain Breach: ${domain} in ${breach.Name}`,
        content: [
          `Domain: ${domain}`,
          `Breach: ${breach.Name}`,
          breach.Title ? `Title: ${breach.Title}` : '',
          breach.BreachDate ? `Breach Date: ${breach.BreachDate}` : '',
          breach.DataClasses ? `Data Types: ${breach.DataClasses.join(', ')}` : '',
          breach.PwnCount ? `Accounts Affected: ${breach.PwnCount.toLocaleString()}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        tags: {
          recon_source: 'email',
          recon_type: 'domain_breach',
          parent_event_id: parentEventId,
          domain,
          breach_name: breach.Name,
          breach_date: breach.BreachDate,
          data_classes: breach.DataClasses,
          pwn_count: breach.PwnCount,
        },
      });
      reconHourlyCount++;
    }
  } catch (err) {
    console.error(`[reconEmail] Domain check failed for ${domain}:`, err instanceof Error ? err.message : String(err));
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
      'recon_email',
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
