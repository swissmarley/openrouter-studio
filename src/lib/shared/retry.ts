/** Retry policy for upstream OpenRouter calls. Pure so it can be unit-tested. */

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Parses Retry-After (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null | undefined, nowMs = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  const delta = date - nowMs;
  return delta > 0 ? delta : null;
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Longest Retry-After we are willing to honor before giving up on waiting that long. */
  maxRetryAfterMs?: number;
  random?: () => number;
}

/**
 * Delay before retry number `attempt` (0-based). A server-provided Retry-After wins;
 * otherwise exponential backoff with full jitter, which spreads out synchronized retries.
 */
export function backoffDelay(attempt: number, retryAfterMs: number | null, opts: BackoffOptions = {}): number {
  const { baseMs = 500, maxMs = 8000, maxRetryAfterMs = 30_000, random = Math.random } = opts;
  if (retryAfterMs !== null) return Math.min(retryAfterMs, maxRetryAfterMs);
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
