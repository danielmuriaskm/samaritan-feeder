// Entity extraction using regex patterns

export interface ExtractedEntity {
  type: EntityType;
  value: string;
  confidence: number;
  context?: string;
}

export type EntityType =
  | 'ipv4'
  | 'ipv6'
  | 'domain'
  | 'email'
  | 'hash_md5'
  | 'hash_sha1'
  | 'hash_sha256'
  | 'cve'
  | 'asn'
  | 'btc_address';

const PATTERNS: { type: EntityType; regex: RegExp; confidence: number }[] = [
  {
    type: 'ipv4',
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    confidence: 1.0,
  },
  {
    type: 'ipv6',
    regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}\b|\b(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}\b|\b[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}\b|\b::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|\b::\b/g,
    confidence: 1.0,
  },
  {
    type: 'email',
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    confidence: 1.0,
  },
  {
    type: 'hash_md5',
    regex: /\b[a-f0-9]{32}\b/gi,
    confidence: 0.9,
  },
  {
    type: 'hash_sha1',
    regex: /\b[a-f0-9]{40}\b/gi,
    confidence: 0.9,
  },
  {
    type: 'hash_sha256',
    regex: /\b[a-f0-9]{64}\b/gi,
    confidence: 0.95,
  },
  {
    type: 'cve',
    regex: /\bCVE-\d{4}-\d{4,}\b/gi,
    confidence: 1.0,
  },
  {
    type: 'asn',
    regex: /\bAS\d{1,6}\b/gi,
    confidence: 0.85,
  },
  {
    type: 'btc_address',
    regex: /\b(?:1|3)[a-zA-Z0-9]{25,34}\b|\bbc1[a-zA-Z0-9]{39,59}\b/g,
    confidence: 0.85,
  },
];

// Domain pattern is more complex — avoid matching email domains and IP-like strings
const DOMAIN_REGEX = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g;
const EXCLUDED_DOMAINS = new Set([
  'com', 'org', 'net', 'gov', 'edu', 'io', 'co', 'www', 'http', 'https',
  'github.com', 'twitter.com', 'x.com', 'reddit.com', 'youtube.com',
  'instagram.com', 'tiktok.com', 'telegram.org', 'discord.com',
  'bsky.app', 'linkedin.com', 'facebook.com',
]);

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  for (const { type, regex, confidence } of PATTERNS) {
    const matches = text.matchAll(regex);
    for (const match of matches) {
      const value = match[0].toLowerCase().trim();
      const key = `${type}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Filter out false-positive IPv4 (e.g., version numbers like 1.2.3)
      if (type === 'ipv4') {
        const parts = value.split('.').map(Number);
        if (parts.some((p) => p > 255)) continue;
        if (parts[0] === 0 || parts[0] === 127) continue; // loopback / zero
      }

      entities.push({
        type,
        value,
        confidence,
        context: extractContext(text, match.index ?? 0, value.length),
      });
    }
  }

  // Extract domains
  const domainMatches = text.matchAll(DOMAIN_REGEX);
  for (const match of domainMatches) {
    const value = match[0].toLowerCase().trim();
    if (EXCLUDED_DOMAINS.has(value)) continue;
    if (value.endsWith('.com') && value.split('.').length === 2 && value.length < 8) continue; // skip short generic domains

    const key = `domain:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Don't double-count email domains
    if (entities.some((e) => e.type === 'email' && e.value.endsWith(`@${value}`))) continue;

    entities.push({
      type: 'domain',
      value,
      confidence: 0.9,
      context: extractContext(text, match.index ?? 0, value.length),
    });
  }

  return entities;
}

function extractContext(text: string, index: number, length: number, window = 60): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}
