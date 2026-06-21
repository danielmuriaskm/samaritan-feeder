import type { EventKind, ScoreComponents } from '../types.js';

/**
 * Composite event scoring — the keystone of "most important first".
 *
 * The feeder used to carry a single numeric, `confidence` (just the LLM's urgency
 * clamped 0..1), and every read path ordered by `event_at DESC`. This blends five
 * orthogonal signals the feeder already produces but never combined: rule/kind
 * severity, threat enrichment (VT/Shodan/MITRE tags), cross-source corroboration,
 * source trust tier, and freshness decay.
 *
 * Clean-room: a transparent weighted blend + exponential freshness decay. The
 * weights below are this project's own editorial choices, not copied from any
 * source. Pure and deterministic so it is unit-testable and stable.
 */

export interface ScoreInput {
  event: {
    kind: EventKind;
    confidence: number;
    tags: Record<string, unknown>;
    eventAt: number;
  };
  /** Defaults to Date.now(); injectable for tests. */
  now?: number;
  /** Source trust in 0..1 (see scoring/sourceTrust). Defaults to 0.5 (neutral). */
  sourceTrust?: number;
  /** Number of independent sources/cluster members corroborating. Defaults to 1. */
  corroboration?: number;
}

// Editorial weights (sum to 1.0). Severity and threat dominate; freshness is a
// gentle tie-breaker so a slightly older high-severity item still outranks fresh noise.
const W = {
  severity: 0.30,
  threat: 0.25,
  corroboration: 0.18,
  sourceTrust: 0.15,
  freshness: 0.12,
} as const;

/** Freshness half-life: a 6h-old event keeps half its freshness weight. */
const FRESHNESS_HALFLIFE_MS = 6 * 60 * 60 * 1000;

export function computeScore(input: ScoreInput): { score: number; components: ScoreComponents } {
  const now = input.now ?? Date.now();
  const { kind, confidence, tags, eventAt } = input.event;
  const t = tags ?? {};

  const severity = severityScore(kind, t);
  const threat = threatScore(t);
  const corroboration = corroborationScore(input.corroboration ?? 1);
  const sourceTrust = clamp01(input.sourceTrust ?? 0.5);
  const freshness = clamp01(2 ** (-Math.max(0, now - eventAt) / FRESHNESS_HALFLIFE_MS));
  const base = clamp01(confidence ?? 0.5);

  const composite =
    W.severity * severity +
    W.threat * threat +
    W.corroboration * corroboration +
    W.sourceTrust * sourceTrust +
    W.freshness * freshness;

  // Blend in a small amount of the raw LLM confidence so events whose enrichment
  // dimensions are all empty still get a sensible non-zero prior.
  const score = clamp01(0.85 * composite + 0.15 * base);

  return { score, components: { severity, threat, corroboration, sourceTrust, freshness, base } };
}

function severityScore(kind: EventKind, tags: Record<string, unknown>): number {
  let s: number;
  switch (kind) {
    case 'alert': s = 1.0; break;
    case 'anomaly': s = 0.7; break;
    case 'trend': s = 0.5; break;
    case 'detection': s = 0.4; break;
    default: s = 0.3; // visual | text | social_post
  }
  // A fired push-worthy CV/rule alert pins severity high regardless of kind.
  const firings = tags.alertFirings;
  if (Array.isArray(firings) && firings.some((f) => f && (f as { severity?: string }).severity !== 'detection')) {
    s = Math.max(s, 0.9);
  }
  return clamp01(s);
}

function threatScore(tags: Record<string, unknown>): number {
  let t = 0;

  const vt = Number(tags.vt_malicious);
  if (Number.isFinite(vt) && vt > 0) t = Math.max(t, clamp01(vt / 5)); // 5+ engines => maxed

  const vulns = tags.shodan_vulns;
  if (Array.isArray(vulns) && vulns.length > 0) t = Math.max(t, clamp01(0.5 + 0.1 * vulns.length));

  // MITRE technique enrichment may surface under a few tag shapes.
  const mitre = tags.mitre ?? tags.mitreTechniques ?? tags.attack ?? tags.techniques;
  if (mitre && (Array.isArray(mitre) ? mitre.length > 0 : true)) t = Math.max(t, 0.6);

  if (tags.recon_type === 'combo_intel') t = Math.max(t, 0.5);
  if (tags.breached === true || Number(tags.breach_count) > 0) t = Math.max(t, 0.55);

  return clamp01(t);
}

/** log2-scaled: 1 source => 0, 2 => ~0.33, 4 => ~0.66, 8+ => ~1. */
function corroborationScore(count: number): number {
  const n = Math.max(1, Math.floor(count));
  return clamp01(Math.log2(n) / 3);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
