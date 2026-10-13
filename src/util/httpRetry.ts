const RETRY_AFTER_DEFAULT_SEC = 1;
const RETRY_AFTER_MIN_SEC = 0.25;
const RETRY_AFTER_MAX_MS = 30_000;

/** Clamped to [250ms, 30s]; HTTP-date form isn't supported and falls back to 1s. */
export function parseRetryAfterMs(header: string | null): number {
  const parsed = Number(header ?? String(RETRY_AFTER_DEFAULT_SEC));
  const seconds = Number.isFinite(parsed) ? parsed : RETRY_AFTER_DEFAULT_SEC;
  return Math.min(Math.max(seconds, RETRY_AFTER_MIN_SEC) * 1000, RETRY_AFTER_MAX_MS);
}

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504] as const;

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUSES.some((s) => s === status);
}
