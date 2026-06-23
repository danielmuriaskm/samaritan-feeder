import type { RiskBand } from '../types.js';

/**
 * Discrete risk band from a composite 0..1 score (006).
 *
 * The composite score is `clamp01(0.85·composite + 0.15·base)` (scoring/score.ts);
 * with severity/threat dominating and freshness a small tie-breaker, real scores
 * cluster well below 1.0, so the band thresholds are deliberately NOT naive
 * quartiles (which would starve HIGH). They are this project's editorial cutoffs.
 *
 * Pure + dependency-free so it is unit-testable and reusable by the events read
 * path, the dashboard risk-matrix, signal banding, and delivery routing.
 */
export const RISK_BAND_THRESHOLDS = { HIGH: 0.66, MEDIUM: 0.5, LOW: 0.33 } as const;

export function deriveRiskBand(score: number | undefined | null): RiskBand {
  const s = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  if (s >= RISK_BAND_THRESHOLDS.HIGH) return 'HIGH';
  if (s >= RISK_BAND_THRESHOLDS.MEDIUM) return 'MEDIUM';
  if (s >= RISK_BAND_THRESHOLDS.LOW) return 'LOW';
  return 'INFO';
}

/** Count items per band — for the dashboard "how many HIGH things are live" block. */
export function riskMatrix(scores: Array<number | undefined | null>): Record<RiskBand, number> {
  const out: Record<RiskBand, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const s of scores) out[deriveRiskBand(s)] += 1;
  return out;
}

/** Order used when rendering bands high→low. */
export const RISK_BAND_ORDER: RiskBand[] = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];
