/**
 * API-key pool — round-robin across multiple keys (e.g. several Ollama Cloud or
 * Jina free accounts) to spread load past any single account's concurrency/quota
 * cap, with per-call failover when a key is throttled or quota-exhausted.
 *
 * Each independent pool (chat keys vs embedding keys) gets its OWN rotator via
 * `makeRotator()` so their cursors don't interfere. A rotator call returns the
 * keys ordered at its cursor (then advances it): that array is BOTH the
 * round-robin starting choice AND the failover order for that single request.
 */

/** Pure: `keys` rotated so index `start` comes first. */
export function orderFrom(keys: string[], start: number): string[] {
  const n = keys.length;
  if (n === 0) return [];
  const s = ((start % n) + n) % n;
  return keys.map((_, i) => keys[(s + i) % n]);
}

/** Create an independent round-robin rotator with its own private cursor. */
export function makeRotator(): (keys: string[]) => string[] {
  let cursor = 0;
  return (keys: string[]): string[] => {
    if (keys.length <= 1) return keys.slice();
    const order = orderFrom(keys, cursor);
    cursor = (cursor + 1) % keys.length;
    return order;
  };
}

/**
 * HTTP statuses worth failing over to ANOTHER key: rate limit / quota / payment
 * required / transient upstream errors. A 4xx like 401/400 is a bad request or a
 * dead key — failing over won't help and would just burn the other keys, so those
 * are NOT retryable here.
 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 429 || // too many requests / quota
    status === 402 || // payment required (quota exhausted on some providers)
    status === 408 || // request timeout
    status === 425 || // too early
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}
