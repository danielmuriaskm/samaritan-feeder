/**
 * Area-of-Interest (AOI) scope predicate — PURE, no DB (006).
 *
 * Clean-room concept port of SpiderFoot's Target scope model
 * (smicallef/spiderfoot, MIT — target.py matches() / in-scope-vs-affiliate),
 * reimagined for a perpetual feeder. Where SpiderFoot decides whether an
 * observation is *in scope* for a single scan target (and otherwise an
 * "affiliate"), this answers: does this event fall inside any configured
 * AOI rule, and how strongly?
 *
 * No code copied — this is an independent reimplementation of the idea with the
 * feeder's own rule kinds, definition shapes, and a clamped weighted match.
 *
 * Pure + deterministic so it is trivially unit-testable. The DB-backed rule set
 * is loaded by store/aoi.ts (getEnabledAoi) and passed in by the scheduler.
 */

import { pointInBox, haversineDistance } from '../geo/utils.js';
import type { AoiRule } from '../store/aoi.js';

/** Minimal event shape the predicate needs — a subset of IntelligenceEvent. */
export interface AoiEvent {
  tags: Record<string, unknown>;
  location?: { lat: number; lon: number };
  title?: string;
  content?: string;
}

export interface AoiMatchResult {
  /** Clamped match strength in 0..1. 0 when nothing matched. */
  score: number;
  matched: boolean;
  /** Ids of the rules that fired, in evaluation order. */
  matchedRuleIds: string[];
}

/**
 * Evaluate an event against a set of AOI rules.
 *
 * Each enabled rule is tested by its `kind`. A matching rule contributes its
 * `weight`. The final score is the larger of (a) the max matched rule weight and
 * (b) the summed weights — both clamped to 0..1 — so one strong rule or several
 * weak ones can both saturate the signal, but the result never exceeds 1.
 *
 * Disabled rules are skipped. Unknown kinds are ignored (never match).
 */
export function aoiScore(event: AoiEvent, rules: AoiRule[]): AoiMatchResult {
  const matchedRuleIds: string[] = [];
  let maxWeight = 0;
  let sumWeight = 0;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesRule(event, rule)) continue;
    const w = Number.isFinite(rule.weight) ? rule.weight : 1.0;
    matchedRuleIds.push(rule.id);
    if (w > maxWeight) maxWeight = w;
    sumWeight += w;
  }

  const matched = matchedRuleIds.length > 0;
  const score = matched ? clamp01(Math.max(clamp01(maxWeight), clamp01(sumWeight))) : 0;
  return { score, matched, matchedRuleIds };
}

/**
 * Coarse in-scope tag for a match result. `in_aoi` when anything matched,
 * otherwise undefined. The integrator decides affiliate semantics (e.g. tagging
 * near-misses or related-but-out-of-scope events 'affiliate'); we only ever
 * emit the positive label here.
 */
export function aoiTag(result: AoiMatchResult): 'in_aoi' | 'affiliate' | undefined {
  return result.matched ? 'in_aoi' : undefined;
}

// ---------------------------------------------------------------------------
// Per-kind matchers
// ---------------------------------------------------------------------------

function matchesRule(event: AoiEvent, rule: AoiRule): boolean {
  const def = rule.definition ?? {};
  switch (rule.kind) {
    case 'geo_bbox':
      return matchGeoBbox(event, def);
    case 'geo_radius':
      return matchGeoRadius(event, def);
    case 'country':
      return matchCodeList(event.tags.country, def.codes);
    case 'region':
      return matchCodeList(event.tags.region, def.regions);
    case 'entity':
      return matchEntity(event, def.values);
    case 'domain':
      return matchDomain(event, def.domains);
    case 'keyword':
      return matchKeyword(event, def.keywords);
    default:
      return false;
  }
}

function matchGeoBbox(event: AoiEvent, def: Record<string, unknown>): boolean {
  const loc = event.location;
  if (!loc || !isFiniteNum(loc.lat) || !isFiniteNum(loc.lon)) return false;
  const minLat = Number(def.minLat);
  const minLon = Number(def.minLon);
  const maxLat = Number(def.maxLat);
  const maxLon = Number(def.maxLon);
  if (![minLat, minLon, maxLat, maxLon].every(isFiniteNum)) return false;
  return pointInBox(loc, { minLat, minLon, maxLat, maxLon });
}

function matchGeoRadius(event: AoiEvent, def: Record<string, unknown>): boolean {
  const loc = event.location;
  if (!loc || !isFiniteNum(loc.lat) || !isFiniteNum(loc.lon)) return false;
  const lat = Number(def.lat);
  const lon = Number(def.lon);
  const radiusKm = Number(def.radiusKm);
  if (![lat, lon, radiusKm].every(isFiniteNum) || radiusKm < 0) return false;
  return haversineDistance({ lat, lon }, loc) <= radiusKm;
}

/** Country/region: the event's tag value must be one of the rule's codes (case-insensitive). */
function matchCodeList(tagValue: unknown, codes: unknown): boolean {
  const wanted = toStringSet(codes);
  if (wanted.size === 0) return false;
  for (const v of toStringList(tagValue)) {
    if (wanted.has(v.toUpperCase())) return true;
  }
  return false;
}

/** Entity: any of the rule's values appears in tags.entities (string or {value}/{name}). */
function matchEntity(event: AoiEvent, values: unknown): boolean {
  const wanted = toStringSet(values);
  if (wanted.size === 0) return false;
  const entities = event.tags.entities;
  for (const e of asArray(entities)) {
    const name = entityName(e);
    if (name && wanted.has(name.toUpperCase())) return true;
  }
  return false;
}

/** Domain: tags.domain or any of tags.domains matches a rule domain (suffix-aware). */
function matchDomain(event: AoiEvent, domains: unknown): boolean {
  const wanted = [...toStringSet(domains)].map((d) => d.replace(/^\.+/, ''));
  if (wanted.length === 0) return false;
  const candidates = new Set<string>();
  for (const v of toStringList(event.tags.domain)) candidates.add(v.toLowerCase());
  for (const v of toStringList(event.tags.domains)) candidates.add(v.toLowerCase());
  for (const cand of candidates) {
    for (const w of wanted) {
      const lw = w.toLowerCase();
      // exact match or a subdomain of the wanted apex (foo.example.com vs example.com)
      if (cand === lw || cand.endsWith(`.${lw}`)) return true;
    }
  }
  return false;
}

/** Keyword: case-insensitive substring of (title + content). */
function matchKeyword(event: AoiEvent, keywords: unknown): boolean {
  const wanted = toStringList(keywords).map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  if (wanted.length === 0) return false;
  const haystack = `${event.title ?? ''}\n${event.content ?? ''}`.toLowerCase();
  if (!haystack.trim()) return false;
  return wanted.some((k) => haystack.includes(k));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entityName(e: unknown): string | undefined {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.value === 'string') return o.value;
    if (typeof o.name === 'string') return o.name;
  }
  return undefined;
}

/** Coerce a tag value (string | string[] | unknown) to a list of strings. */
function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Uppercased set for case-insensitive membership tests (codes/values). */
function toStringSet(value: unknown): Set<string> {
  const out = new Set<string>();
  for (const v of toStringList(value)) {
    const t = v.trim();
    if (t) out.add(t.toUpperCase());
  }
  return out;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
