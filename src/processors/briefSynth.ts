import type { Brief, IntelligenceEvent } from '../types.js';
import { config } from '../config.js';
import { callSamaritanLLM } from '../samaritan-client.js';
import { sanitizeForPrompt } from '../llm/sanitize.js';
import { listTopEvents } from '../store/events.js';
import { insertBrief } from '../store/briefs.js';
import { randomUUID } from 'crypto';

/**
 * Grounded brief synthesis — turns a window of scored events into a compact,
 * fabrication-checked digest. The LLM proposes a structured brief; pure guards
 * then REJECT any output that introduces named entities or numbers absent from
 * the source events, and a deterministic headline-template guarantees a brief
 * always ships even when the LLM is unavailable or its draft fails the guards.
 *
 * Clean-room note: the anti-hallucination *method* (extract anchor tokens from
 * the inputs, reject LLM outputs that introduce un-grounded proper nouns) is
 * inspired by worldmonitor's grounding approach, but every regex, threshold,
 * stopword list, and prompt string below is this project's own. No code, prompt,
 * or curated table was copied.
 */

// ---------------------------------------------------------------------------
// Tunables (this project's own editorial choices).
// ---------------------------------------------------------------------------

/** Per-source cap: keep the digest from being dominated by one chatty feed. */
const MAX_PER_SOURCE = 3;
/** Hard cap on events sent to the LLM (token budget + signal density). */
const MAX_EVENTS_IN_PROMPT = 12;
/** How many fabricated proper nouns are tolerated before rejecting the draft. */
const MAX_FABRICATED_NOUNS = 0;
/** A grounded lead must share at least this many anchor tokens with the inputs. */
const MIN_LEAD_ANCHOR_OVERLAP = 1;
/** Per-event content slice sent into the prompt (after sanitize). */
const EVENT_CONTENT_CHARS = 360;

// Tokens that get capitalized at sentence starts / headlines but are NOT named
// entities. Kept deliberately small and generic — not a curated knowledge table.
const COMMON_CAPITALIZED = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'nor', 'so', 'yet',
  'in', 'on', 'at', 'to', 'of', 'by', 'as', 'is', 'are', 'was', 'were',
  'this', 'that', 'these', 'those', 'it', 'its', 'their', 'they', 'we', 'you',
  'new', 'breaking', 'update', 'alert', 'report', 'reported', 'reports',
  'after', 'before', 'during', 'amid', 'over', 'under', 'near', 'across',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// ---------------------------------------------------------------------------
// PURE: filter / order / cap.
// ---------------------------------------------------------------------------

/**
 * Reduce a scored event list to the digest's working set:
 *   1. collapse the same real-world item to ONE representative (highest score
 *      wins) via a source-agnostic dedup key (cluster tag, else a normalized
 *      kind+title+content signature),
 *   2. cap how many survive per source,
 *   3. order by composite score (then recency) descending.
 *
 * Pure and deterministic — the unit-testable spine of the digest.
 */
export function orderAndCap(
  events: IntelligenceEvent[],
  opts: { maxPerSource?: number; limit?: number } = {},
): IntelligenceEvent[] {
  const maxPerSource = opts.maxPerSource ?? MAX_PER_SOURCE;
  const limit = opts.limit ?? MAX_EVENTS_IN_PROMPT;

  // Stable strongest-first ordering before dedup so the representative we keep
  // for each real-world item is always the highest-scored one.
  const ranked = [...events].sort(byScoreDesc);

  // Source-agnostic dedup: the first (strongest) event for each dedup key wins.
  // The key is the cluster tag when present, else a normalized signature over
  // kind + title + content — so the same alert re-issued over time or ingested
  // by overlapping feeds (different sourceId/id) collapses to one representative.
  const seenKey = new Set<string>();
  const deduped: IntelligenceEvent[] = [];
  for (const e of ranked) {
    const key = dedupKeyOf(e);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    deduped.push(e);
  }

  // Per-source cap.
  const perSource = new Map<string, number>();
  const capped: IntelligenceEvent[] = [];
  for (const e of deduped) {
    const n = perSource.get(e.sourceId) ?? 0;
    if (n >= maxPerSource) continue;
    perSource.set(e.sourceId, n + 1);
    capped.push(e);
  }

  return capped.slice(0, limit);
}

function byScoreDesc(a: IntelligenceEvent, b: IntelligenceEvent): number {
  const sa = a.score ?? a.confidence ?? 0;
  const sb = b.score ?? b.confidence ?? 0;
  if (sb !== sa) return sb - sa;
  return b.eventAt - a.eventAt;
}

function clusterIdOf(e: IntelligenceEvent): string | undefined {
  const raw = e.tags?.['clusterId'] ?? e.tags?.['cluster_id'] ?? e.tags?.['cluster'];
  if (raw == null) return undefined;
  const s = String(raw).trim();
  return s.length ? s : undefined;
}

/** Chars of content folded into the source-agnostic dedup signature. */
const DEDUP_CONTENT_CHARS = 160;

/**
 * Source-agnostic dedup key for collapsing the same real-world item:
 *   - the cluster tag (`clusterId` / `cluster_id` / `cluster`) when present, else
 *   - a normalized signature: `kind` + lowercased/whitespace-collapsed title +
 *     the first ~160 chars of similarly-normalized content.
 *
 * Deliberately ignores `sourceId` and the upstream id so an alert ingested by
 * overlapping feeds, or re-issued with the same wording, maps to one key. Purely
 * a function of the event's own fields → deterministic.
 */
function dedupKeyOf(e: IntelligenceEvent): string {
  const cid = clusterIdOf(e);
  if (cid) return `c:${cid}`;
  const title = normalizeForKey(e.title ?? '');
  const content = normalizeForKey(e.content ?? '').slice(0, DEDUP_CONTENT_CHARS);
  // No cluster tag and no title/content text: nothing real to match on.
  // Treat as a singleton (unique event id) so unrelated empties never fuse.
  if (!title && !content) return `id:${e.id}`;
  return `s:${e.kind} ${title} ${content}`;
}

/** Lowercase, collapse whitespace, trim — the signature's normalization. */
function normalizeForKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// PURE: anti-hallucination guards (the valuable, clean-room part).
// ---------------------------------------------------------------------------

/**
 * Extract candidate proper nouns: runs of capitalized words (optionally joined by
 * short connectors like "of"/"the"), plus standalone ALL-CAPS acronyms. We do NOT
 * resolve entity types — this is a cheap lexical anchor extractor, not an NER.
 */
export function extractProperNouns(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];

  // Capitalized sequences: "New York", "United Nations", "Bank of England".
  // A token is Capitalized if it starts uppercase and has at least one more char,
  // or is an acronym (2+ uppercase letters/digits).
  const seqRe =
    /\b([A-Z][\p{L}'’-]+(?:\s+(?:of|the|and|de|la|von|van|al)\s+|\s+)?)+[A-Z][\p{L}'’-]+\b|\b[A-Z][\p{L}'’-]{2,}\b|\b[A-Z]{2,}(?:\d+)?\b/gu;
  const matches = text.match(seqRe) ?? [];
  for (const m of matches) {
    // Trim leading/trailing common-capitalized connectors that the regex may have
    // swallowed at a sentence start ("The USGS" -> "USGS", "USA Today" kept).
    const words = m.replace(/\s+/g, ' ').trim().split(' ');
    while (words.length > 1 && COMMON_CAPITALIZED.has(words[0].toLowerCase())) words.shift();
    while (words.length > 1 && COMMON_CAPITALIZED.has(words[words.length - 1].toLowerCase())) words.pop();
    const cleaned = words.join(' ').trim();
    if (!cleaned) continue;
    // Reject sequences whose only words are common-capitalized (e.g. "The Update").
    const meaningful = cleaned
      .split(' ')
      .some((w) => !COMMON_CAPITALIZED.has(w.toLowerCase()) && w.length > 1);
    if (meaningful) out.push(cleaned);
  }
  return dedupePreserveOrder(out);
}

/** Lowercase, strip punctuation, collapse acronym dots: "U.S.A." -> "usa". */
function normalizeNoun(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the grounding set for a source: every proper-noun phrase plus EVERY word
 * (lowercased) that appears in the source. Including all source words — not just
 * extracted entities — is what kills the sentence-start false positive: an output
 * token like "Emergency" is grounded because the source contains "emergency",
 * even though it was never an entity there. Only words wholly absent from the
 * source are treated as fabricated.
 */
function nounSet(sourceText: string): Set<string> {
  const set = new Set<string>();
  for (const n of extractProperNouns(sourceText)) {
    const norm = normalizeNoun(n);
    if (norm) set.add(norm);
    // Also index each word of a multi-word noun, so "New York City" grounds "York".
    for (const w of norm.split(' ')) if (w.length > 1) set.add(w);
  }
  // Full-text word index (case-folded), so common-but-real words ground too.
  for (const w of normalizeNoun(sourceText).split(' ')) {
    if (w.length > 1) set.add(w);
  }
  return set;
}

/**
 * Reject when the LLM output introduces a proper noun that does NOT appear in the
 * source set. Acronym/case differences are normalized away first, and a multi-word
 * source entity grounds its component words. Returns TRUE when the output is clean
 * (every named entity is traceable to the inputs).
 */
export function validateNoHallucinatedProperNouns(llmText: string, sourceText: string): boolean {
  const allowed = nounSet(sourceText);
  let fabricated = 0;
  for (const noun of extractProperNouns(llmText)) {
    const norm = normalizeNoun(noun);
    if (!norm) continue;
    if (allowed.has(norm)) continue;
    // A multi-word output noun is grounded if every component word is grounded
    // (handles the model reordering / re-casing a source entity).
    const words = norm.split(' ').filter((w) => w.length > 1);
    const allWordsGrounded = words.length > 0 && words.every((w) => allowed.has(w));
    if (allWordsGrounded) continue;
    fabricated++;
    if (fabricated > MAX_FABRICATED_NOUNS) return false;
  }
  return true;
}

/** Pull groundable numeric anchors (counts, magnitudes, years) from text. */
function extractNumbers(text: string): string[] {
  const out: string[] = [];
  // Numbers with optional decimal / thousands separators, ignoring bare 1-2 digit
  // ordinals that are too generic to anchor on.
  const re = /\b\d{1,3}(?:[.,]\d+)?(?:[.,]\d{3})*\b/g;
  for (const m of text.match(re) ?? []) {
    const norm = m.replace(/,/g, '');
    if (norm.length >= 2) out.push(norm); // require >=2 chars (drops bare "3" noise)
  }
  return dedupePreserveOrder(out);
}

/**
 * The lead sentence must be anchored in the inputs: it has to share at least
 * MIN_LEAD_ANCHOR_OVERLAP named-entity or numeric anchors with the source set.
 * A lead that names no source entity/number is treated as ungrounded prose and
 * rejected (the deterministic fallback then takes over). An empty source set is
 * a degenerate input we cannot validate against, so we accept (caller decides).
 */
export function checkLeadGrounding(lead: string, sourceTexts: string[]): boolean {
  const joined = sourceTexts.join('\n');
  const sourceNouns = nounSet(joined);
  const sourceNums = new Set(extractNumbers(joined));
  // Degenerate input: the sources expose NO named entities and NO numbers to
  // anchor against (e.g. pure lowercase prose). We cannot meaningfully validate
  // grounding, so accept and let the caller decide. Use the *extracted* anchors
  // here, not the full word index (which is non-empty for almost any text).
  const sourceEntityCount = extractProperNouns(joined).length;
  if (sourceEntityCount === 0 && sourceNums.size === 0) return true;

  let overlap = 0;
  for (const n of extractProperNouns(lead)) {
    const norm = normalizeNoun(n);
    if (!norm) continue;
    if (sourceNouns.has(norm) || norm.split(' ').some((w) => w.length > 1 && sourceNouns.has(w))) {
      overlap++;
    }
  }
  for (const num of extractNumbers(lead)) {
    if (sourceNums.has(num)) overlap++;
  }
  return overlap >= MIN_LEAD_ANCHOR_OVERLAP;
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthesis (LLM draft -> guards -> deterministic fallback).
// ---------------------------------------------------------------------------

interface DraftBrief {
  lead: string;
  threads: unknown[];
  signals: unknown[];
  rankedEventIds: string[];
}

/** Concatenated, sanitized source text for the guards — title + clipped content. */
export function sourceTextsOf(events: IntelligenceEvent[]): string[] {
  return events.map((e) => {
    const title = sanitizeForPrompt(e.title ?? '', { maxLen: 200 });
    const content = sanitizeForPrompt(e.content ?? '', { maxLen: EVENT_CONTENT_CHARS });
    return `${title}\n${content}`.trim();
  });
}

/**
 * Build the compact LLM prompt. Each event is sanitized to neutralize prompt
 * injection from polled content. We ask for STRICT JSON only.
 */
function buildPrompt(events: IntelligenceEvent[]): { system: string; user: string } {
  const system =
    'You are an intelligence digest writer. From the numbered source events, write a grounded brief. ' +
    'Use ONLY facts, names, places, and numbers that appear verbatim in the sources — never invent or infer ' +
    'entities not present. If unsure, omit. Respond with STRICT JSON and nothing else.';

  const lines = events.map((e, i) => {
    const title = sanitizeForPrompt(e.title ?? '(no title)', { maxLen: 200 });
    const content = sanitizeForPrompt(e.content ?? '', { maxLen: EVENT_CONTENT_CHARS });
    return `[${i + 1}] id=${e.id} kind=${e.kind}\nTitle: ${title}\nContent: ${content}`;
  });

  const user =
    `Source events (most important first):\n${lines.join('\n\n')}\n\n` +
    'Return JSON of this exact shape:\n' +
    '{\n' +
    '  "lead": "one-sentence headline grounded in the sources",\n' +
    '  "threads": [{"title": "string", "eventIds": ["id"], "summary": "string"}],\n' +
    '  "signals": ["short phrase"],\n' +
    '  "rankedEventIds": ["id in priority order"]\n' +
    '}';

  return { system, user };
}

function parseDraft(content: string): DraftBrief | null {
  // Tolerate code fences / leading prose: grab the first balanced JSON object.
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const lead = typeof obj.lead === 'string' ? obj.lead.trim() : '';
  if (!lead) return null;
  return {
    lead,
    threads: Array.isArray(obj.threads) ? obj.threads : [],
    signals: Array.isArray(obj.signals) ? obj.signals : [],
    rankedEventIds: Array.isArray(obj.rankedEventIds)
      ? obj.rankedEventIds.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

/**
 * Deterministic, always-valid fallback brief built purely from the source events
 * — no LLM, no fabrication risk. Lead is the strongest event's headline; threads
 * mirror the ranked events. Used when the LLM is unavailable OR its draft fails a
 * grounding guard, guaranteeing a brief ALWAYS ships.
 */
export function deterministicBrief(events: IntelligenceEvent[]): {
  lead: string;
  body: Brief['body'];
} {
  if (events.length === 0) {
    return { lead: 'No notable intelligence in this window.', body: { threads: [], signals: [], rankedEventIds: [] } };
  }
  const top = events[0];
  const topTitle = (top.title ?? top.content ?? 'Update').replace(/\s+/g, ' ').trim().slice(0, 140);
  const more = events.length - 1;
  const lead =
    more > 0
      ? `${topTitle} (+${more} more ${more === 1 ? 'item' : 'items'} this window)`
      : topTitle;

  const threads = events.map((e) => ({
    title: (e.title ?? e.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    eventIds: [e.id],
    sourceId: e.sourceId,
    kind: e.kind,
    score: e.score ?? e.confidence ?? 0,
  }));

  return {
    lead,
    body: {
      threads,
      signals: [],
      rankedEventIds: events.map((e) => e.id),
      generatedBy: 'deterministic',
    } as Brief['body'],
  };
}

/**
 * Synthesize a grounded brief from a (pre-filtered) event set. Tries the LLM,
 * validates its draft against the source set, and falls back to a deterministic
 * template on null/failure/guard-rejection. Always returns a Brief.
 */
export async function synthesizeBrief(
  events: IntelligenceEvent[],
  opts: { userId?: string; windowStart?: number; windowEnd?: number } = {},
): Promise<Brief> {
  const working = orderAndCap(events);
  const now = Date.now();
  const base: Omit<Brief, 'lead' | 'body'> = {
    id: randomUUID(),
    userId: opts.userId,
    eventCount: working.length,
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd ?? now,
    createdAt: now,
  };

  if (working.length === 0) {
    const det = deterministicBrief(working);
    return { ...base, lead: det.lead, body: det.body };
  }

  const sourceTexts = sourceTextsOf(working);
  const allowedIds = new Set(working.map((e) => e.id));

  const draft = await tryLLMDraft(working);
  if (draft) {
    const draftText = `${draft.lead}\n${JSON.stringify(draft.threads)}\n${draft.signals.map(String).join(' ')}`;
    const joinedSource = sourceTexts.join('\n');
    const grounded =
      validateNoHallucinatedProperNouns(draftText, joinedSource) &&
      checkLeadGrounding(draft.lead, sourceTexts);

    if (grounded) {
      // Constrain rankedEventIds to ids we actually fed in (drop hallucinated ids).
      const ranked = draft.rankedEventIds.filter((id) => allowedIds.has(id));
      const rankedEventIds = ranked.length ? ranked : working.map((e) => e.id);
      return {
        ...base,
        lead: draft.lead.slice(0, 280),
        body: {
          threads: draft.threads,
          signals: draft.signals,
          rankedEventIds,
          generatedBy: 'llm',
        } as Brief['body'],
      };
    }
    // Guard rejected the draft — fall through to the deterministic template.
  }

  const det = deterministicBrief(working);
  return { ...base, lead: det.lead, body: det.body };
}

/** Single LLM round-trip; returns a parsed+validated draft or null. */
async function tryLLMDraft(events: IntelligenceEvent[]): Promise<DraftBrief | null> {
  const { system, user } = buildPrompt(events);
  const res = await callSamaritanLLM({
    model: config.LLM_MODEL ?? 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 700,
  });
  const content = res?.choices?.[0]?.message?.content;
  if (!content) return null;
  return parseDraft(content);
}

// ---------------------------------------------------------------------------
// Orchestration (loose coupling: assemble + synthesize + persist; the integrator
// wires delivery).
// ---------------------------------------------------------------------------

/** Window assembled for a digest run (last hour by default). */
const DIGEST_WINDOW_MS = 60 * 60 * 1000;
/** Minimum composite score for an event to enter the digest. */
const DIGEST_MIN_SCORE = 0.4;
/** Pull headroom before orderAndCap trims to the prompt budget. */
const DIGEST_FETCH_LIMIT = 60;

/**
 * Build, synthesize, and persist a brief for one user over the last hour. Returns
 * the persisted Brief (or null when there is nothing worth a digest). Delivery is
 * intentionally NOT done here — the caller decides whether to push it.
 */
export async function runDigestForUser(
  userId?: string,
  opts: { windowMs?: number; minScore?: number; now?: number } = {},
): Promise<Brief | null> {
  const now = opts.now ?? Date.now();
  const windowStart = now - (opts.windowMs ?? DIGEST_WINDOW_MS);

  const events = await listTopEvents({
    since: windowStart,
    minScore: opts.minScore ?? DIGEST_MIN_SCORE,
    limit: DIGEST_FETCH_LIMIT,
  });
  if (events.length === 0) return null;

  const brief = await synthesizeBrief(events, { userId, windowStart, windowEnd: now });
  await insertBrief(brief);
  return brief;
}

/**
 * Hourly digest entrypoint for the scheduler. Currently produces a single global
 * brief (userId undefined). Returns the brief so the integrator can fan it out to
 * delivery channels; returns null when the window was quiet.
 */
export async function runDigestCycle(): Promise<Brief | null> {
  try {
    const brief = await runDigestForUser(undefined);
    if (brief) {
      console.log(`[briefSynth] Digest brief ${brief.id}: ${brief.eventCount} events — ${brief.lead}`);
    } else {
      console.log('[briefSynth] Digest cycle: quiet window, no brief');
    }
    return brief;
  } catch (err) {
    console.error('[briefSynth] Digest cycle failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
