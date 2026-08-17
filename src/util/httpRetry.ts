// Shared HTTP retry primitives, so the Discord webhook and the OpenRouter LLM transport share one Retry-After implementation.

const RETRY_AFTER_DEFAULT_SEC = 1;
const RETRY_AFTER_MIN_SEC = 0.25;
const RETRY_AFTER_MAX_MS = 30_000;

/** Converts a `Retry-After` header to a wait in ms, clamped to [250ms, 30s]. HTTP-date form isn't supported and falls back to the 1s default. */
export function parseRetryAfterMs(header: string | null): number {
  const parsed = Number(header ?? String(RETRY_AFTER_DEFAULT_SEC));
  const seconds = Number.isFinite(parsed) ? parsed : RETRY_AFTER_DEFAULT_SEC;
  return Math.min(Math.max(seconds, RETRY_AFTER_MIN_SEC) * 1000, RETRY_AFTER_MAX_MS);
}

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504] as const;

/** Rate limits plus transient server errors are worth retrying; other 4xx (request-shaped problems) fail identically on retry. Status-code half of the job errorCause.ts does for thrown errors. */
export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUSES.some((s) => s === status);
}
