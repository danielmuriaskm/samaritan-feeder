import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { bus } from '../bus.js';
import { insertSignal, signalDedupeExists } from '../store/signals.js';
import { deriveRiskBand } from '../scoring/severity.js';
import {
  kindToFamily,
  loadRecentConvergenceEvents,
  type ConvergenceEvent,
  type SourceFamily,
} from './convergence.js';
import type { IntelSignal, RiskBand, SourceKind } from '../types.js';

/**
 * Declarative rule engine (006).
 *
 * A small, dependency-light correlation engine that runs over the recent event
 * stream and emits IntelSignal{kind:'rule_match'}. Rules are authored as YAML in
 * `src/processors/rules/*.yaml`: a restricted, well-documented schema with a
 * `collect` (filter) -> `aggregate` (group) -> `analysis` (test) -> `headline`
 * pipeline. Each surviving group becomes one signal.
 *
 * Clean-room note: the IDEA of a declarative collect/aggregate/analysis
 * correlation DSL is inspired by SpiderFoot's correlation engine
 * (smicallef/spiderfoot, MIT — spiderfoot/correlation.py, correlations/*.yaml,
 * correlations/README.md, correlations/template.yaml). None of its code, schema
 * field set, queries, thresholds or rule files are copied. This is a TypeScript
 * reimplementation against samaritan's own ConvergenceEvent projection and event
 * model (kind/sourceKind/sourceFamily/tags/geoCell), with our own matcher set,
 * analysis methods, validation, scoring and dedupe scheme.
 *
 * The matching core (`evaluateRule`) is PURE (no DB, no clock side-effects) so
 * it is unit-testable on a fixture; `runRuleEngine()` is the only async shell
 * that reads events and writes signals, mirroring `runConvergence()`.
 */

// ---------------------------------------------------------------------------
// Schema types. A Rule is a single YAML document. The shape is deliberately
// small: one list of collect matchers (ANDed), one aggregate field, one
// analysis method, one headline. (SpiderFoot supports multiple collections and
// inter-collection set-difference analyzers; we do not — that complexity lives
// in convergence.ts's hand-written detectors instead.)
// ---------------------------------------------------------------------------

export type RuleRisk = RiskBand; // 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH'

/** Fields a matcher / aggregator can resolve against a ConvergenceEvent. */
export type RuleField =
  | 'kind'
  | 'sourceKind'
  | 'sourceFamily'
  | 'geoCell'
  | `tags.${string}`;

export type MatchMethod = 'exact' | 'regex' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte';

/**
 * One filter clause. All matchers in a rule's `collect` list must pass (logical
 * AND) for an event to be collected.
 *
 *  - exact:  string equality against `value`. `value` may be a list (OR). A
 *            single value (or any list item) may carry a leading `not ` prefix
 *            to negate that comparison.
 *  - regex:  JS RegExp test against the field's string form. `value` may be a
 *            list (OR). `not ` prefix negates.
 *  - exists: the field resolves to a non-null/non-empty value (no `value`).
 *  - gt/gte/lt/lte: numeric comparison of the field (coerced to Number) vs
 *            `value` (a number).
 */
export interface Matcher {
  method: MatchMethod;
  field: RuleField;
  /** string | number | (string|number)[] depending on method; absent for `exists`. */
  value?: string | number | Array<string | number>;
}

export type AnalysisMethod = 'threshold' | 'outlier';

/**
 * Analysis over the aggregated groups.
 *
 *  - threshold: keep a group whose size meets the bounds. By default the bound
 *      is the member COUNT; set `distinctField` to instead count DISTINCT values
 *      of that field within the group (e.g. distinct sources). `minCount`/
 *      `maxCount` bound the metric.
 *  - outlier: keep groups whose share of the total collected volume is
 *      `<= maximumPercent`, with a noisy-data guard: skip entirely if total <
 *      `minTotal`, or if the mean bucket share is below `noisyPercent` (the axis
 *      is already so fragmented that "rare" is the norm).
 */
export interface Analysis {
  method: AnalysisMethod;
  // threshold
  minCount?: number;
  maxCount?: number;
  /** Count distinct values of this field per group instead of raw member count. */
  distinctField?: RuleField;
  // outlier
  maximumPercent?: number;
  noisyPercent?: number;
  minTotal?: number;
}

export interface RuleMeta {
  name: string;
  description?: string;
  risk: RuleRisk;
}

export interface Rule {
  id: string;
  version: number;
  meta: RuleMeta;
  collect: Matcher[];
  aggregate: { field: RuleField };
  analysis: Analysis;
  /** Headline template; `{field}` interpolates the group's aggregate value. */
  headline: string;
}

/** One surviving group => one signal candidate. PURE output of evaluateRule. */
export interface Match {
  ruleId: string;
  /** The aggregate field's value for this group (the bucket key). */
  groupKey: string;
  /** Members of the group (the events that fell into this bucket). */
  events: ConvergenceEvent[];
  eventIds: string[];
  sourceIds: string[];
  /** Metric the analysis produced (count or distinct-count or member count). */
  metric: number;
}

// ---------------------------------------------------------------------------
// Risk -> score mapping (clean-room originals). Mirrors the bands used by
// deriveRiskBand so the stored score and the stored band agree.
// ---------------------------------------------------------------------------
const RISK_SCORE: Record<RuleRisk, number> = {
  HIGH: 0.85,
  MEDIUM: 0.6,
  LOW: 0.4,
  INFO: 0.25,
};

const VALID_RISKS: RuleRisk[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH'];
const VALID_MATCH_METHODS: MatchMethod[] = ['exact', 'regex', 'exists', 'gt', 'gte', 'lt', 'lte'];
const VALID_ANALYSIS_METHODS: AnalysisMethod[] = ['threshold', 'outlier'];

// ---------------------------------------------------------------------------
// Field resolution. Projects a ConvergenceEvent onto a named field. Returns a
// string for categorical fields (the bucket key form), or undefined when the
// value is absent. Numeric comparisons re-coerce with Number().
// ---------------------------------------------------------------------------
const GEO_CELL_DEG = 1;

function resolveField(ev: ConvergenceEvent, field: RuleField): string | undefined {
  switch (field) {
    case 'kind':
      return ev.kind;
    case 'sourceKind':
      return ev.sourceKind;
    case 'sourceFamily':
      return kindToFamily(ev.sourceKind);
    case 'geoCell': {
      if (!ev.location || !isFinite(ev.location.lat) || !isFinite(ev.location.lon)) return undefined;
      const latBin = Math.floor(ev.location.lat / GEO_CELL_DEG);
      const lonBin = Math.floor(ev.location.lon / GEO_CELL_DEG);
      return `${latBin}:${lonBin}`;
    }
    default: {
      // tags.<dotted.path>
      if (field.startsWith('tags.')) {
        const path = field.slice('tags.'.length);
        const v = getDotted(ev.tags, path);
        if (v == null) return undefined;
        if (typeof v === 'string') return v.length ? v : undefined;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return undefined; // objects/arrays are not categorical keys
      }
      return undefined;
    }
  }
}

/** Walk a dotted path into a plain object (tags). */
function getDotted(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Matchers.
// ---------------------------------------------------------------------------
const NOT_PREFIX = 'not ';

function asList(v: Matcher['value']): Array<string | number> {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Apply one matcher to one event. */
function matchOne(ev: ConvergenceEvent, m: Matcher): boolean {
  switch (m.method) {
    case 'exists':
      return resolveField(ev, m.field) !== undefined;

    case 'exact': {
      const actual = resolveField(ev, m.field);
      // List = OR. Each item may be `not <x>` to negate. With only negations,
      // ALL must hold (none-of); a single positive item satisfies as soon as it
      // matches. We OR positives and AND negatives, the natural reading.
      const items = asList(m.value).map((x) => String(x));
      if (items.length === 0) return false;
      let sawPositive = false;
      let positiveHit = false;
      for (const item of items) {
        if (item.startsWith(NOT_PREFIX)) {
          const want = item.slice(NOT_PREFIX.length);
          if (actual === want) return false; // a negated value matched -> reject
        } else {
          sawPositive = true;
          if (actual === item) positiveHit = true;
        }
      }
      return sawPositive ? positiveHit : true;
    }

    case 'regex': {
      const actual = resolveField(ev, m.field);
      if (actual === undefined) return false;
      const items = asList(m.value).map((x) => String(x));
      if (items.length === 0) return false;
      let sawPositive = false;
      let positiveHit = false;
      for (const item of items) {
        const negated = item.startsWith(NOT_PREFIX);
        const pattern = negated ? item.slice(NOT_PREFIX.length) : item;
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          // A malformed pattern can't match anything. For a positive clause this
          // contributes no hit; for a negated clause "does not match" holds, so
          // either way we just move on.
          continue;
        }
        const hit = re.test(actual);
        if (negated) {
          if (hit) return false;
        } else {
          sawPositive = true;
          if (hit) positiveHit = true;
        }
      }
      return sawPositive ? positiveHit : true;
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const raw = resolveField(ev, m.field);
      if (raw === undefined) return false;
      const actual = Number(raw);
      const bound = Number(asList(m.value)[0]);
      if (!isFinite(actual) || !isFinite(bound)) return false;
      if (m.method === 'gt') return actual > bound;
      if (m.method === 'gte') return actual >= bound;
      if (m.method === 'lt') return actual < bound;
      return actual <= bound;
    }

    default:
      return false;
  }
}

/** An event is collected iff EVERY matcher passes (logical AND). */
function collect(events: ConvergenceEvent[], matchers: Matcher[]): ConvergenceEvent[] {
  return events.filter((ev) => matchers.every((m) => matchOne(ev, m)));
}

// ---------------------------------------------------------------------------
// Aggregation + analysis -> Matches. PURE.
// ---------------------------------------------------------------------------

function groupBy(events: ConvergenceEvent[], field: RuleField): Map<string, ConvergenceEvent[]> {
  const out = new Map<string, ConvergenceEvent[]>();
  for (const ev of events) {
    const key = resolveField(ev, field);
    if (key === undefined) continue; // events with no value on the axis don't bucket
    const bucket = out.get(key);
    if (bucket) bucket.push(ev);
    else out.set(key, [ev]);
  }
  return out;
}

function distinctCount(events: ConvergenceEvent[], field: RuleField): number {
  const seen = new Set<string>();
  for (const ev of events) {
    const v = resolveField(ev, field);
    if (v !== undefined) seen.add(v);
  }
  return seen.size;
}

function toMatch(ruleId: string, groupKey: string, members: ConvergenceEvent[], metric: number): Match {
  return {
    ruleId,
    groupKey,
    events: members,
    eventIds: [...new Set(members.map((m) => m.id))].sort(),
    sourceIds: [...new Set(members.map((m) => m.sourceId))].sort(),
    metric,
  };
}

/**
 * Evaluate a single rule over a set of events, returning the surviving groups.
 * PURE: no DB, no clock. This is the unit-testable core.
 */
export function evaluateRule(rule: Rule, events: ConvergenceEvent[]): Match[] {
  const collected = collect(events, rule.collect);
  const groups = groupBy(collected, rule.aggregate.field);
  const a = rule.analysis;
  const out: Match[] = [];

  if (a.method === 'threshold') {
    const min = a.minCount;
    const max = a.maxCount;
    for (const [groupKey, members] of groups) {
      const metric = a.distinctField ? distinctCount(members, a.distinctField) : members.length;
      if (min != null && metric < min) continue;
      if (max != null && metric > max) continue;
      out.push(toMatch(rule.id, groupKey, members, metric));
    }
  } else {
    // outlier: rare buckets by share of total collected volume.
    const maximumPercent = a.maximumPercent ?? 0.1;
    const noisyPercent = a.noisyPercent ?? 0.05;
    const minTotal = a.minTotal ?? 20;

    let total = 0;
    for (const members of groups.values()) total += members.length;
    if (total >= minTotal && groups.size > 0) {
      const avgShare = 1 / groups.size; // a tiny mean share => already fragmented/noisy
      if (avgShare >= noisyPercent) {
        for (const [groupKey, members] of groups) {
          const share = members.length / total;
          if (share > maximumPercent) continue;
          out.push(toMatch(rule.id, groupKey, members, members.length));
        }
      }
    }
  }

  // Strongest (largest metric) first — useful for callers that cap output.
  out.sort((x, y) => y.metric - x.metric);
  return out;
}

// ---------------------------------------------------------------------------
// Headline interpolation. `{field}` => the group key; `{metric}` => the metric.
// ---------------------------------------------------------------------------
function interpolateHeadline(template: string, match: Match): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name === 'field') return match.groupKey;
    if (name === 'metric') return String(match.metric);
    return `{${name}}`;
  });
}

// ---------------------------------------------------------------------------
// Validation: a check_rule_validity equivalent. Returns null if valid, else a
// reason string. Malformed rules are skipped + warned so one bad file can't
// crash the whole run.
// ---------------------------------------------------------------------------
function isRuleField(v: unknown): v is RuleField {
  if (typeof v !== 'string') return false;
  return (
    v === 'kind' ||
    v === 'sourceKind' ||
    v === 'sourceFamily' ||
    v === 'geoCell' ||
    v.startsWith('tags.')
  );
}

export function checkRuleValidity(raw: unknown): { rule?: Rule; error?: string } {
  if (raw == null || typeof raw !== 'object') return { error: 'rule is not a mapping' };
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== 'string' || !r.id) return { error: 'missing/invalid id' };
  if (r.version !== 1 && r.version !== undefined) {
    return { error: `unsupported version ${String(r.version)} (only 1)` };
  }

  const meta = r.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') return { error: 'missing meta' };
  if (typeof meta.name !== 'string' || !meta.name) return { error: 'missing meta.name' };
  if (typeof meta.risk !== 'string' || !VALID_RISKS.includes(meta.risk as RuleRisk)) {
    return { error: `meta.risk must be one of ${VALID_RISKS.join('|')}` };
  }

  if (!Array.isArray(r.collect) || r.collect.length === 0) {
    return { error: 'collect must be a non-empty list' };
  }
  const collect: Matcher[] = [];
  for (const c of r.collect) {
    if (!c || typeof c !== 'object') return { error: 'collect item is not a mapping' };
    const cm = c as Record<string, unknown>;
    if (typeof cm.method !== 'string' || !VALID_MATCH_METHODS.includes(cm.method as MatchMethod)) {
      return { error: `bad collect.method ${String(cm.method)}` };
    }
    if (!isRuleField(cm.field)) return { error: `bad collect.field ${String(cm.field)}` };
    if (cm.method !== 'exists' && cm.value === undefined) {
      return { error: `collect.method ${cm.method} requires a value` };
    }
    collect.push({
      method: cm.method as MatchMethod,
      field: cm.field as RuleField,
      value: cm.value as Matcher['value'],
    });
  }

  const agg = r.aggregate as Record<string, unknown> | undefined;
  if (!agg || typeof agg !== 'object' || !isRuleField(agg.field)) {
    return { error: 'aggregate.field is required and must be a valid field' };
  }

  const an = r.analysis as Record<string, unknown> | undefined;
  if (!an || typeof an !== 'object') return { error: 'missing analysis' };
  if (typeof an.method !== 'string' || !VALID_ANALYSIS_METHODS.includes(an.method as AnalysisMethod)) {
    return { error: `analysis.method must be one of ${VALID_ANALYSIS_METHODS.join('|')}` };
  }
  if (an.method === 'threshold' && an.minCount == null && an.maxCount == null) {
    return { error: 'threshold analysis needs minCount and/or maxCount' };
  }
  if (an.distinctField !== undefined && !isRuleField(an.distinctField)) {
    return { error: `bad analysis.distinctField ${String(an.distinctField)}` };
  }

  if (typeof r.headline !== 'string' || !r.headline) return { error: 'missing headline' };

  const rule: Rule = {
    id: r.id,
    version: 1,
    meta: {
      name: meta.name,
      description: typeof meta.description === 'string' ? meta.description : undefined,
      risk: meta.risk as RuleRisk,
    },
    collect,
    aggregate: { field: agg.field as RuleField },
    analysis: {
      method: an.method as AnalysisMethod,
      minCount: numOrUndef(an.minCount),
      maxCount: numOrUndef(an.maxCount),
      distinctField: an.distinctField as RuleField | undefined,
      maximumPercent: numOrUndef(an.maximumPercent),
      noisyPercent: numOrUndef(an.noisyPercent),
      minTotal: numOrUndef(an.minTotal),
    },
    headline: r.headline,
  };
  return { rule };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Loading. Resolve the rules dir relative to this module (works under dist when
// the build copies the YAMLs alongside), with a fallback to the source tree so
// it also works when run via ts-node / before a copy step.
// ---------------------------------------------------------------------------
function candidateRuleDirs(explicit?: string): string[] {
  if (explicit) return [explicit];
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, 'rules'), // compiled: dist/processors/rules (if copied) OR src/processors/rules
    resolve(here, '..', '..', 'src', 'processors', 'rules'), // dist/processors -> repo/src/processors/rules
    resolve(here, '..', '..', '..', 'src', 'processors', 'rules'), // deeper nesting fallback
  ];
}

/**
 * Read every `*.yaml` in the rules dir, parse + validate, and return the valid
 * Rule[]. Malformed files are skipped with a warning so one bad rule can't abort
 * loading. Safe-by-default parse via js-yaml `load()`.
 */
export function loadRules(dir?: string): Rule[] {
  let chosen: string | undefined;
  for (const candidate of candidateRuleDirs(dir)) {
    if (existsSync(candidate)) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) {
    console.warn('[ruleEngine] no rules directory found; ran with 0 rules');
    return [];
  }

  const out: Rule[] = [];
  const seen = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(chosen).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch (err) {
    console.warn(`[ruleEngine] cannot read rules dir ${chosen}: ${String(err)}`);
    return [];
  }

  for (const file of files) {
    const path = join(chosen, file);
    let parsed: unknown;
    try {
      parsed = yaml.load(readFileSync(path, 'utf-8'));
    } catch (err) {
      console.warn(`[ruleEngine] skipping ${file}: YAML parse error: ${String(err)}`);
      continue;
    }
    const { rule, error } = checkRuleValidity(parsed);
    if (error || !rule) {
      console.warn(`[ruleEngine] skipping ${file}: invalid rule: ${error}`);
      continue;
    }
    if (seen.has(rule.id)) {
      console.warn(`[ruleEngine] skipping ${file}: duplicate rule id "${rule.id}"`);
      continue;
    }
    seen.add(rule.id);
    out.push(rule);
  }
  return out;
}

/** Eagerly-loaded rule set (lazy-cached on first access). */
let _rules: Rule[] | null = null;
export function getRules(): Rule[] {
  if (_rules == null) _rules = loadRules();
  return _rules;
}

// ---------------------------------------------------------------------------
// Orchestrator. Mirrors runConvergence(): read recent events, evaluate every
// rule, persist NEW matches as IntelSignal{kind:'rule_match'}, emit on the bus.
// ---------------------------------------------------------------------------
const RECENT_EVENT_LIMIT = 4000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunRuleEngineOptions {
  /** Lookback window (ms). Defaults to 24h. */
  windowMs?: number;
  /** Anti-spam: re-fire the same dedupe key only after this many ms. Defaults to windowMs. */
  dedupeWindowMs?: number;
  /** Injectable clock for testing. */
  now?: number;
  /** Injectable event loader (defaults to the DB read). */
  load?: (sinceMs: number) => Promise<ConvergenceEvent[]>;
  /** Injectable rule set (defaults to the loaded YAML rules). */
  rules?: Rule[];
}

export interface RunRuleEngineResult {
  scanned: number;
  fired: number;
  signals: IntelSignal[];
}

export async function runRuleEngine(opts: RunRuleEngineOptions = {}): Promise<RunRuleEngineResult> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const dedupeWindowMs = opts.dedupeWindowMs ?? windowMs;
  const load = opts.load ?? loadRecentConvergenceEvents;
  const rules = opts.rules ?? getRules();

  const events = await load(now - windowMs);
  // Defensive cap so a wide window can't blow past the convergence projection's
  // own limit on the in-memory work set.
  const work = events.length > RECENT_EVENT_LIMIT ? events.slice(0, RECENT_EVENT_LIMIT) : events;
  const dedupeSince = now - dedupeWindowMs;
  const fired: IntelSignal[] = [];

  for (const rule of rules) {
    let matches: Match[];
    try {
      matches = evaluateRule(rule, work);
    } catch (err) {
      // One bad rule must never abort the batch.
      console.warn(`[ruleEngine] rule "${rule.id}" threw during evaluation: ${String(err)}`);
      continue;
    }

    for (const match of matches) {
      try {
        const dedupeKey = `rule:${rule.id}:${match.groupKey}`;
        if (await signalDedupeExists(dedupeKey, dedupeSince)) continue;

        const score = RISK_SCORE[rule.meta.risk];
        const title = interpolateHeadline(rule.headline, match);
        const summary =
          `${rule.meta.name}: ${match.events.length} event(s) in group "${match.groupKey}" ` +
          `(metric ${match.metric})`;

        const sig = await insertSignal({
          kind: 'rule_match',
          score,
          riskBand: deriveRiskBand(score),
          title,
          summary,
          eventIds: match.eventIds,
          sourceIds: match.sourceIds,
          dedupeKey,
          metadata: {
            ruleId: rule.id,
            risk: rule.meta.risk,
            groupKey: match.groupKey,
            metric: match.metric,
            analysis: rule.analysis.method,
          },
          createdAt: now,
        });
        bus.emitSignal(sig);
        fired.push(sig);
      } catch (err) {
        console.warn(`[ruleEngine] rule "${rule.id}" failed to persist a match: ${String(err)}`);
      }
    }
  }

  if (fired.length) {
    console.log(
      `[ruleEngine] ${fired.length} new rule_match signal(s) from ${work.length} events ` +
        `across ${rules.length} rule(s)`,
    );
  }
  return { scanned: work.length, fired: fired.length, signals: fired };
}

// Re-export the projection types so callers/tests can build fixtures without a
// second import of convergence.ts.
export type { ConvergenceEvent, SourceFamily, SourceKind };
