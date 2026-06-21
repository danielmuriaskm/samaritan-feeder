import type { SourceConfig, SourceKind } from '../types.js';
import { tierForKind, trustForTier, type SourceTier } from '../config/sourceTiers.js';

/**
 * Resolve a 0..1 trust weight for a source, feeding the composite scorer's
 * `sourceTrust` dimension. Precedence:
 *   1. explicit per-source override `config.trustTier` (1..4) or `config.trust` (0..1)
 *   2. the kind's default tier (config/sourceTiers)
 *
 * Clean-room: a tier lookup with an override hook; no external code.
 */
export function trustForSource(source: Pick<SourceConfig, 'kind' | 'config'>): number {
  const cfg = source.config ?? {};

  const explicit = Number((cfg as Record<string, unknown>).trust);
  if (Number.isFinite(explicit) && explicit >= 0 && explicit <= 1) return explicit;

  const overrideTier = Number((cfg as Record<string, unknown>).trustTier);
  if (overrideTier === 1 || overrideTier === 2 || overrideTier === 3 || overrideTier === 4) {
    return trustForTier(overrideTier as SourceTier);
  }

  return trustForTier(tierForKind(source.kind));
}

/** Convenience: trust from a bare kind (no per-source override available). */
export function trustForKind(kind: SourceKind): number {
  return trustForTier(tierForKind(kind));
}
