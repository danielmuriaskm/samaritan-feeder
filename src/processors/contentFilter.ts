/**
 * Content filtering pipeline for raw events.
 * Removes spam, duplicates, and unwanted content before LLM processing.
 */

const SPAM_PATTERNS = [
  /\b(buy now|click here|limited time|act now|subscribe now)\b/i,
  /\b(earn \$\d+|make money fast|work from home)\b/i,
  /\b(viagra|cialis|crypto scam|nft giveaway)\b/i,
];

const LOW_QUALITY_PATTERNS = [
  /^\s*$/,
  /^(posted by|submitted by|via)\s/i,
];

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

export function filterContent(title: string, content: string): FilterResult {
  const combined = `${title} ${content}`;

  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(combined)) {
      return { pass: false, reason: 'spam_detected' };
    }
  }

  for (const pattern of LOW_QUALITY_PATTERNS) {
    if (pattern.test(content)) {
      return { pass: false, reason: 'low_quality' };
    }
  }

  if (content.length < 20 && !title) {
    return { pass: false, reason: 'too_short' };
  }

  return { pass: true };
}

export function filterLanguage(text: string): FilterResult {
  // Simple heuristic: reject if >40% non-ASCII (likely non-Latin script we can't handle well)
  const nonAscii = Array.from(text).filter((c) => c.charCodeAt(0) > 127).length;
  if (text.length > 50 && nonAscii / text.length > 0.4) {
    return { pass: false, reason: 'non_latin_script' };
  }
  return { pass: true };
}
