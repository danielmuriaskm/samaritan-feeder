/**
 * Per-source circuit breaker — pure backoff math.
 *
 * The scheduler polls every source on a cron tick; a source that 500s, rate-limits
 * (429), or soft-blocks a scraper would otherwise be retried every minute forever,
 * burning Fly.io CPU and the upstream's goodwill. After `failureThreshold`
 * consecutive failures the breaker opens and imposes an exponentially growing
 * cooldown (capped), reset to closed on the first success.
 *
 * Clean-room: a failure-count -> exponential-backoff-cooldown state machine is a
 * standard pattern; no third-party code involved. Deterministic and unit-tested.
 */
export interface BreakerConfig {
  /** Consecutive failures before the breaker opens (default 3). */
  failureThreshold?: number;
  /** Cooldown for the first opened step (default 5 min). */
  baseMs?: number;
  /** Maximum cooldown (default 6 h). */
  maxMs?: number;
}

const DEFAULTS: Required<BreakerConfig> = {
  failureThreshold: 3,
  baseMs: 5 * 60 * 1000,
  maxMs: 6 * 60 * 60 * 1000,
};

/**
 * Cooldown end timestamp given the (already-incremented) consecutive failure
 * count, or `undefined` while still below the threshold (keep polling normally).
 */
export function nextCooldownUntil(
  consecutiveFailures: number,
  now: number,
  cfg: BreakerConfig = {},
): number | undefined {
  const { failureThreshold, baseMs, maxMs } = { ...DEFAULTS, ...cfg };
  if (consecutiveFailures < failureThreshold) return undefined;
  const step = consecutiveFailures - failureThreshold; // 0,1,2,...
  const backoff = Math.min(maxMs, baseMs * 2 ** step);
  return now + backoff;
}

/** True while the source is cooling down and must be skipped this tick. */
export function isInCooldown(state: { cooldownUntil?: number | null }, now: number): boolean {
  return state.cooldownUntil != null && now < state.cooldownUntil;
}
