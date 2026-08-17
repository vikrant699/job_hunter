import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { parseRetryAfterMs } from "../util/httpRetry.js";
import type { JsonValue } from "../util/json.js";

const WEBHOOK_TIMEOUT_MS = 15_000;
const WEBHOOK_MAX_429_RETRIES = 3;

/** POST a JSON body to a Discord webhook with timeout + 429/transient retry; throws on a non-retryable failure. */
export async function postWebhookJson(url: string, body: JsonValue): Promise<void> {
  for (let attempt = 0; attempt <= WEBHOOK_MAX_429_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout/network failure retries like a 429 rather than losing the notification to a blip.
      if (attempt < WEBHOOK_MAX_429_RETRIES) {
        logger.warn({ attempt, err: String(err).slice(0, 120) }, "Discord webhook fetch failed; retrying");
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }

    if (res.status === 429 && attempt < WEBHOOK_MAX_429_RETRIES) {
      const waitMs = parseRetryAfterMs(res.headers.get("retry-after"));
      logger.warn({ waitMs, attempt }, "Discord 429; backing off");
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
