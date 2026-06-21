import type { AlertFiring, AlertRule, CvAnalytics } from '../types.js';

/**
 * Alert-rules engine — the "signal-not-noise" layer.
 *
 * Pure function over the already-sanitized, anonymous CV aggregates. Routine
 * per-poll analytics stay `kind:'detection'`; only a fired rule produces a
 * push-worthy `kind:'alert'` event (Frigate's Detection-vs-Alert split). No
 * imagery or identity is involved — rules operate on integers/enums.
 */
export function evaluateAlertRules(cv: CvAnalytics, rules: AlertRule[] | undefined): AlertFiring[] {
  if (!rules?.length) return [];
  const firings: AlertFiring[] = [];

  for (const rule of rules) {
    const severity = rule.severity ?? 'alert';
    let value: number | undefined;

    switch (rule.type) {
      case 'crowd_threshold':
        value = cv.peakPerson ?? cv.counts.person ?? 0;
        break;
      case 'zone_breach': {
        const z = cv.zones.find((zz) => zz.id === rule.zoneId);
        value = z ? z.peakOccupancy ?? z.occupancy : 0;
        break;
      }
      case 'loitering': {
        const relevant = cv.tracks.filter((t) => !rule.zoneId || t.zonesEntered.includes(rule.zoneId));
        const maxDwell = relevant.reduce((m, t) => Math.max(m, t.maxDwellSec ?? 0), 0);
        value = rule.zoneId ? maxDwell : cv.dwellMaxSec ?? maxDwell;
        break;
      }
      case 'line_surge': {
        const l = cv.lines.find((ll) => ll.id === rule.lineId);
        value = l ? l.in + l.out : 0;
        break;
      }
      default:
        value = undefined;
    }

    if (value !== undefined && Number.isFinite(value) && value >= rule.threshold) {
      firings.push({
        ruleId: rule.id,
        type: rule.type,
        zoneId: rule.zoneId,
        lineId: rule.lineId,
        value,
        threshold: rule.threshold,
        severity,
      });
    }
  }
  return firings;
}

/** Deterministic, PII-free alert headline, e.g. "loitering @ plaza (72s ≥ 60)". */
export function buildAlertText(firings: AlertFiring[]): string {
  return firings
    .map((f) => {
      const where = f.zoneId ? ` @ ${f.zoneId}` : f.lineId ? ` @ ${f.lineId}` : '';
      return `${f.type.replace(/_/g, ' ')}${where} (${round(f.value)} >= ${f.threshold})`;
    })
    .join('; ');
}

/** Highest-severity firing wins for the event title/kind. */
export function hasPushSeverity(firings: AlertFiring[]): boolean {
  return firings.some((f) => f.severity === 'alert');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
