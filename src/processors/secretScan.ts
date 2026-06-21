import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

interface SecretPattern {
  name: string;
  regex: RegExp;
  entropyThreshold?: number;
  minLength?: number;
}

const PATTERNS: SecretPattern[] = [
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g, entropyThreshold: 3.5 },
  { name: 'aws_secret_key', regex: /\b[A-Za-z0-9/+=]{40}\b/g, entropyThreshold: 4.2, minLength: 40 },
  { name: 'github_pat', regex: /\bghp_[A-Za-z0-9]{36}\b/gi },
  { name: 'github_oauth', regex: /\bgho_[A-Za-z0-9]{36}\b/gi },
  { name: 'slack_token', regex: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}(-[a-zA-Z0-9]{24})?\b/g },
  { name: 'private_key', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g },
  { name: 'google_api', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'generic_api_key', regex: /\b(api[_-]?key|apikey|api-key)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,64})['"]?/gi, entropyThreshold: 3.8 },
  { name: 'db_connection', regex: /(postgres|mysql|mongodb|redis):\/\/[^\s\"']+/gi },
  { name: 'discord_webhook', regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,80}/g },
  { name: 'stripe_key', regex: /\b(sk|pk)_(live|test)_[0-9a-zA-Z]{24,}\b/g },
];

export async function runSecretScan(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_SECRET_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const text = `${event.title ?? ''}\n${event.content}`;
  const secrets = scanText(text);

  // Also scan linked file URLs
  const fileUrls = (event.mediaUrls ?? []).filter((u) => typeof u === 'string');
  for (const url of fileUrls) {
    try {
      const fileSecrets = await scanFileUrl(url);
      secrets.push(...fileSecrets);
    } catch {
      // ignore file fetch failures
    }
  }

  if (secrets.length === 0) return;

  const seen = new Set<string>();
  for (const s of secrets) {
    const key = `${s.pattern}:${s.value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    await createReconEvent({
      title: `Secret found: ${s.pattern}`,
      content: `Pattern: ${s.pattern}\nEntropy: ${s.entropy.toFixed(2)}\nContext: ${s.context}`,
      tags: {
        recon_source: 'secret',
        recon_type: 'secret_scan',
        parent_event_id: event.id,
        secret_pattern: s.pattern,
        secret_value: s.value.slice(0, 20) + (s.value.length > 20 ? '...' : ''),
        secret_entropy: s.entropy,
        secret_context: s.context,
      },
    });
    reconHourlyCount++;
  }
}

function scanText(text: string): Array<{ pattern: string; value: string; entropy: number; context: string }> {
  const found: Array<{ pattern: string; value: string; entropy: number; context: string }> = [];

  for (const p of PATTERNS) {
    const matches = text.matchAll(p.regex);
    for (const match of matches) {
      let value = match[0];
      // For grouped regex, try to extract the actual key
      if (match[2] && typeof match[2] === 'string') {
        value = match[2];
      }

      if (p.minLength && value.length < p.minLength) continue;

      const entropy = shannonEntropy(value);
      if (p.entropyThreshold && entropy < p.entropyThreshold) continue;

      found.push({
        pattern: p.name,
        value,
        entropy,
        context: extractContext(text, match.index ?? 0, value.length),
      });
    }
  }

  return found;
}

async function scanFileUrl(url: string): Promise<Array<{ pattern: string; value: string; entropy: number; context: string }>> {
  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const text = await res.text();
  // Only scan first 20KB
  return scanText(text.slice(0, 20 * 1024));
}

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  const len = str.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function extractContext(text: string, index: number, length: number, window = 60): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
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
      'recon_secret',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.85,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
