/**
 * Shared HTTP retry primitives.
 *
 * `parseRetryAfterMs` was the inline 429 backoff inside discord/webhook.ts - the
 * repo's only Retry-After parser. It is lifted here (semantics unchanged) so the
 * Discord webhook and the OpenRouter LLM transport share one implementation
 * instead of hand-rolling a sixth retry dialect.
 */

const RETRY_AFTER_DEFAULT_SEC = 1;
const RETRY_AFTER_MIN_SEC = 0.25;
const RETRY_AFTER_MAX_MS = 30_000;

/**
 * Convert a `Retry-After` response header to a wait in ms, clamped to
 * [250ms, 30s]. The header is read as whole seconds; the RFC's HTTP-date form is
 * NOT supported and takes the 1s default (matching the behaviour this replaced).
 */
export function parseRetryAfterMs(header: string | null): number {
  const parsed = Number(header ?? String(RETRY_AFTER_DEFAULT_SEC));
  const seconds = Number.isFinite(parsed) ? parsed : RETRY_AFTER_DEFAULT_SEC;
  return Math.min(Math.max(seconds, RETRY_AFTER_MIN_SEC) * 1000, RETRY_AFTER_MAX_MS);
}

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504] as const;

/**
 * Is this status worth another attempt? Rate limits plus the transient server
 * errors. Deliberately excludes 501 (not implemented) and every 4xx other than
 * 429 - those are request-shaped problems that will fail identically on retry.
 *
 * util/errorCause.ts classifies thrown transport errors but is status-blind by
 * design, so this is the status-code half of the same job.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUSES.some((s) => s === status);
}
