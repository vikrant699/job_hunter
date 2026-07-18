import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";

const WEBHOOK_TIMEOUT_MS = 15_000;
const WEBHOOK_MAX_429_RETRIES = 3;

/**
 * POST a JSON body to a Discord webhook with timeout + 429/transient retry.
 * Shared by the match/summary notifier and the progress heartbeat so the retry
 * behavior stays in one place. Throws on a non-retryable failure.
 */
export async function postWebhookJson(url: string, body: unknown): Promise<void> {
  for (let attempt = 0; attempt <= WEBHOOK_MAX_429_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Timeout abort or transient network failure — retry like a 429 rather
      // than losing the notification to a single blip.
      if (attempt < WEBHOOK_MAX_429_RETRIES) {
        logger.warn({ attempt, err: String(err).slice(0, 120) }, "Discord webhook fetch failed; retrying");
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && attempt < WEBHOOK_MAX_429_RETRIES) {
      const parsedRetryAfter = Number(res.headers.get("retry-after") ?? "1");
      const retryAfter = Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : 1;
      const waitMs = Math.min(Math.max(retryAfter, 0.25) * 1000, 30_000);
      logger.warn({ retryAfter, attempt }, "Discord 429; backing off");
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord ${res.status}: ${text.slice(0, 200)}`);
    }
    return;
  }
  throw new Error("Discord 429 retries exhausted");
}
