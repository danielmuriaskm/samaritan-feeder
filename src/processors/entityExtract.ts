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
  | 'hash_sha512'
  | 'cve'
  | 'asn'
  | 'btc_address'
  | 'eth_address'
  | 'iban'
  | 'credit_card'
  | 'analytics_id'
  | 'pgp_key'
  | 'url';

// ---------------------------------------------------------------------------
// Entity quality gate (graph readability). Structured IOC-ish types are ALWAYS
// meaningful; only the free-form types (org/person/place/keyword and any
// LLM-supplied label) get filtered. Drops ultra-short ("ai", "ml", "os"),
// pure-numeric, and a small curated list of generic buzzwords that otherwise
// become huge low-signal hubs in the intelligence graph.
// ---------------------------------------------------------------------------
const STRUCTURED_ENTITY_TYPES = new Set<string>([
  'ipv4', 'ipv6', 'domain', 'email', 'hash_md5', 'hash_sha1', 'hash_sha256',
  'hash_sha512', 'cve', 'asn', 'btc_address', 'eth_address', 'iban', 'credit_card',
  'analytics_id', 'pgp_key', 'url',
]);

const ENTITY_STOPWORDS = new Set<string>([
  // generic tech / product buzzwords
  'ai', 'ml', 'llm', 'llms', 'genai', 'api', 'apis', 'app', 'apps', 'ui', 'ux',
  'os', 'iot', 'gpu', 'cpu', 'sdk', 'cli', 'saas', 'web', 'site', 'blog', 'post',
  'tech', 'code', 'data', 'cloud', 'model', 'models', 'chip', 'chips', 'devops',
  // generic news / filler
  'the', 'new', 'news', 'open', 'show', 'update', 'updates', 'today', 'report',
  'reports', 'plan', 'plans', 'price', 'prices', 'team', 'user', 'users', 'people',
  'company', 'startup', 'startups', 'product', 'service', 'services',
  // org/title filler
  'inc', 'llc', 'ltd', 'corp', 'co', 'group', 'ceo', 'cto', 'cfo', 'gov',
  // ranking filler
  'one', 'two', 'first', 'best', 'top', 'big', 'more', 'most', 'new',
]);

/**
 * True when an entity is too generic to be worth a graph node. Never filters the
 * structured IOC types. Used at link time (store/entities) and at graph read time
 * (routes/graph) so noisy hubs like "ai"/"data" don't dominate the layout.
 */
export function isLowValueEntity(type: string, value: string): boolean {
  if (STRUCTURED_ENTITY_TYPES.has(type)) return false;
  const v = value.trim().toLowerCase();
  if (v.length < 3) return true;
  if (/^\d+$/.test(v)) return true;
  if (ENTITY_STOPWORDS.has(v)) return true;
  return false;
}

// Validators and several patterns below are clean-room ports of the *ideas* in
// SpiderFoot (smicallef/spiderfoot, MIT) — helpers.py (extractIbansFromText,
// extractCreditCardsFromText, extractPgpKeysFromText, extractUrlsFromText,
// validEmail) and the sfp_ethereum / sfp_iban / sfp_webanalytics modules.
// No code was copied; the detection/validation logic was reimplemented.

interface PatternDef {
  type: EntityType;
  regex: RegExp;
  confidence: number;
  // Optional post-match validator. When present, a regex match is only kept if
  // validate() returns true (e.g. IBAN mod-97, credit-card Luhn).
  validate?: (value: string) => boolean;
  // Optional transform of the stored value (e.g. mask a PAN to last-4 only).
  transform?: (value: string) => string;
}

const PATTERNS: PatternDef[] = [
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
    validate: validEmail,
  },
  {
    // PGP public key block — capture the whole armored block (conf 1.0).
    type: 'pgp_key',
    regex: /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g,
    confidence: 1.0,
  },
  {
    // Ethereum address: 0x + 40 hex chars.
    type: 'eth_address',
    regex: /\b0x[a-fA-F0-9]{40}\b/g,
    confidence: 0.9,
  },
  {
    // SHA-512 (128 hex). MUST precede sha256 so a 128-hex run isn't truncated
    // and mis-captured as a 64-hex SHA-256 match.
    type: 'hash_sha512',
    regex: /\b[a-f0-9]{128}\b/gi,
    confidence: 0.95,
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
    // Web-analytics IDs: GA UA-XXXX-Y, GA4 G-XXXXXXX, GTM-XXXXX, AdSense pub-XXXX.
    type: 'analytics_id',
    regex: /\b(?:UA-\d{4,10}-\d{1,4}|G-[A-Z0-9]{6,12}|GTM-[A-Z0-9]{5,9}|pub-\d{14,22})\b/g,
    confidence: 0.9,
  },
  {
    // IBAN: ISO 13616 — 2-letter country, 2 check digits, up to 30 BBAN chars.
    // Kept only if the mod-97 checksum is valid.
    type: 'iban',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    confidence: 0.95,
    validate: validIban,
  },
  {
    // Credit card: 13–19 digit run, optionally grouped by spaces/dashes.
    // Validated with Luhn; the stored value is MASKED to last-4 only so the
    // full PAN is never persisted.
    type: 'credit_card',
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    confidence: 0.9,
    validate: validCreditCard,
    transform: maskCreditCard,
  },
  {
    // Generic URL.
    type: 'url',
    regex: /\bhttps?:\/\/[^\s<>"'()]+/gi,
    confidence: 0.8,
  },
  {
    type: 'btc_address',
    regex: /\b(?:1|3)[a-zA-Z0-9]{25,34}\b|\bbc1[a-zA-Z0-9]{39,59}\b/g,
    confidence: 0.85,
  },
];

// ── Validators ────────────────────────────────────────────────────────────

/**
 * Conservative email sanity check (mirrors SpiderFoot's validEmail idea).
 * Rejects implausibly-short addresses, '%' / '..' sequences, and empty
 * local/domain parts. Normal addresses pass.
 */
export function validEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 6) return false;
  if (v.includes('%')) return false;
  if (v.includes('..')) return false;
  const at = v.indexOf('@');
  if (at <= 0) return false; // no '@' or empty local part
  if (at !== v.lastIndexOf('@')) return false; // more than one '@'
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (!local || !domain) return false;
  if (!domain.includes('.')) return false;
  return true;
}

/**
 * IBAN mod-97 checksum (ISO 7064). Move the 4 leading chars to the end, map
 * letters A=10..Z=35, then take the big number mod 97 — must equal 1.
 * Done digit-by-digit to avoid BigInt / Number overflow on long IBANs.
 */
export function validIban(value: string): boolean {
  const v = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;

  // Rotate first 4 chars to the back.
  const rearranged = v.slice(4) + v.slice(0, 4);

  // Expand each char to its numeric form (letters -> two digits), then reduce
  // the resulting digit string mod 97 one character at a time.
  let remainder = 0;
  for (const ch of rearranged) {
    let chunk: string;
    if (ch >= '0' && ch <= '9') {
      chunk = ch;
    } else {
      // 'A' -> 10 ... 'Z' -> 35
      chunk = String(ch.charCodeAt(0) - 'A'.charCodeAt(0) + 10);
    }
    for (const d of chunk) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Luhn checksum over the digits only (spaces/dashes stripped). The candidate
 * must be 13–19 digits long.
 */
export function validCreditCard(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Privacy-preserving mask: store only the last 4 digits of a PAN.
 * e.g. "4111 1111 1111 1111" -> "************1111". The full number is never
 * persisted.
 */
export function maskCreditCard(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  const last4 = digits.slice(-4);
  return '*'.repeat(12) + last4;
}

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

  // Types whose values must NOT be lowercased: PGP armor and URLs are
  // case-sensitive, masked PANs are digits-only.
  const CASE_SENSITIVE = new Set<EntityType>(['pgp_key', 'url', 'credit_card']);

  for (const { type, regex, confidence, validate, transform } of PATTERNS) {
    const matches = text.matchAll(regex);
    for (const match of matches) {
      const rawMatch = match[0].trim();

      // Reject the match if a validator is present and fails (IBAN mod-97,
      // Luhn, email sanity, …) — checked against the raw matched text.
      if (validate && !validate(rawMatch)) continue;

      // Filter out false-positive IPv4 (e.g., version numbers like 1.2.3)
      if (type === 'ipv4') {
        const parts = rawMatch.split('.').map(Number);
        if (parts.some((p) => p > 255)) continue;
        if (parts[0] === 0 || parts[0] === 127) continue; // loopback / zero
      }

      // Optionally rewrite the stored value (e.g. mask a PAN to last-4 only)
      // so the persisted entity never holds sensitive data.
      const stored = transform ? transform(rawMatch) : rawMatch;
      const value = CASE_SENSITIVE.has(type) ? stored : stored.toLowerCase();

      const key = `${type}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);

      entities.push({
        type,
        value,
        confidence,
        context: extractContext(text, match.index ?? 0, rawMatch.length),
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
