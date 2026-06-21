import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

const TLDS = ['com', 'net', 'org', 'io', 'co', 'info', 'biz', 'me', 'us', 'uk', 'de', 'fr', 'eu', 'app', 'dev', 'cloud', 'tech'];

const HOMOGLYPHS: Record<string, string[]> = {
  a: ['à', 'á', 'â', 'ã', 'ä', 'å', 'α', 'а'],
  c: ['ç', 'ć', 'č', 'с'],
  e: ['è', 'é', 'ê', 'ë', 'е', 'ε'],
  i: ['ì', 'í', 'î', 'ï', 'і', 'ι'],
  o: ['ò', 'ó', 'ô', 'õ', 'ö', 'о', 'ο'],
  p: ['р'],
  s: ['ś', 'š', 'ѕ'],
  x: ['х'],
  y: ['у', 'ý', 'ÿ'],
};

export async function runDnstwist(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_TYPO_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const domains = extractDomains(event);
  if (domains.length === 0) return;

  for (const domain of domains) {
    await checkTyposquats(domain, event.id);
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

async function checkTyposquats(domain: string, parentEventId: string): Promise<void> {
  const mutations = generateMutations(domain);
  const toCheck = mutations.slice(0, 50);

  const found: Array<{ mutation: string; type: string; ip: string }> = [];

  // Check in batches of 10
  const batchSize = 10;
  for (let i = 0; i < toCheck.length; i += batchSize) {
    const batch = toCheck.slice(i, i + batchSize);
    const promises = batch.map(async (m) => {
      try {
        const res = await fetch(
          `https://dns.google/resolve?name=${encodeURIComponent(m.mutation)}&type=A`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { Answer?: Array<{ data: string }> };
        const ip = data.Answer?.[0]?.data;
        if (ip && ip !== '0.0.0.0' && ip !== '127.0.0.1') {
          return { mutation: m.mutation, type: m.type, ip };
        }
      } catch {
        // ignore
      }
      return null;
    });

    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) {
        found.push(s.value);
      }
    }
  }

  if (found.length === 0) return;

  for (const f of found) {
    await createReconEvent({
      title: `Typosquat: ${f.mutation}`,
      content: `Potential typosquatting domain detected:\nOriginal: ${domain}\nMutation: ${f.mutation}\nType: ${f.type}\nResolved IP: ${f.ip}\nRisk: Phishing / brand impersonation`,
      tags: {
        recon_source: 'dnstwist',
        recon_type: 'typosquat',
        parent_event_id: parentEventId,
        original_domain: domain,
        typo_domain: f.mutation,
        mutation_type: f.type,
        resolved_ip: f.ip,
      },
    });
    reconHourlyCount++;
  }
}

function generateMutations(domain: string): Array<{ mutation: string; type: string }> {
  const mutations: Array<{ mutation: string; type: string }> = [];
  const seen = new Set<string>();
  const parts = domain.split('.');
  const name = parts[0];
  const suffix = parts.slice(1).join('.');

  const add = (m: string, type: string) => {
    const full = suffix ? `${m}.${suffix}` : m;
    if (full !== domain && !seen.has(full)) {
      seen.add(full);
      mutations.push({ mutation: full, type });
    }
  };

  // Bitsquatting: flip one bit in each character
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    for (let bit = 0; bit < 8; bit++) {
      const flipped = String.fromCharCode(c ^ (1 << bit));
      if (flipped >= 'a' && flipped <= 'z') {
        add(name.slice(0, i) + flipped + name.slice(i + 1), 'bitsquatting');
      }
    }
  }

  // Homoglyph
  for (let i = 0; i < name.length; i++) {
    const c = name[i].toLowerCase();
    const subs = HOMOGLYPHS[c];
    if (subs) {
      for (const sub of subs) {
        add(name.slice(0, i) + sub + name.slice(i + 1), 'homoglyph');
      }
    }
  }

  // Omission
  for (let i = 0; i < name.length; i++) {
    add(name.slice(0, i) + name.slice(i + 1), 'omission');
  }

  // Insertion
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-';
  for (let i = 0; i <= name.length; i++) {
    for (const ch of chars) {
      add(name.slice(0, i) + ch + name.slice(i), 'insertion');
    }
  }

  // Transposition
  for (let i = 0; i < name.length - 1; i++) {
    add(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2), 'transposition');
  }

  // Repetition
  for (let i = 0; i < name.length; i++) {
    add(name.slice(0, i) + name[i] + name.slice(i), 'repetition');
  }

  // Vowel swap
  const vowels = 'aeiou';
  for (let i = 0; i < name.length; i++) {
    if (vowels.includes(name[i])) {
      for (const v of vowels) {
        if (v !== name[i]) {
          add(name.slice(0, i) + v + name.slice(i + 1), 'vowel-swap');
        }
      }
    }
  }

  // TLD swap
  for (const tld of TLDS) {
    add(`${name}.${tld}`, 'tld-swap');
  }

  // Hyphenation
  for (let i = 1; i < name.length; i++) {
    add(name.slice(0, i) + '-' + name.slice(i), 'hyphenation');
  }

  return mutations;
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
      'recon_dnstwist',
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
