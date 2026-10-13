import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Caught } from "../util/errorCause.js";
import { makeSemaphore } from "../util/semaphore.js";
import { sleep } from "../util/sleep.js";
import { LlmUnavailableError } from "./errors.js";
import { assertOpenRouterAvailable, openRouterGenerate } from "./openrouter.js";
import type { OpenRouterGenerateOpts as GenerateOpts } from "./openrouter.js";

export function isConnectionError(err: Caught): boolean {
  const s = String(err).toLowerCase();
  return (
    s.includes("fetch failed") ||
    s.includes("econnrefused") ||
    s.includes("enotfound") ||
    s.includes("econnreset") ||
    s.includes("socket hang up") ||
    s.includes("network") ||
    s.includes("aborted") ||
    s.includes("timeout")
  );
}

const MAX_CONSECUTIVE_CONN_FAILURES = 5;
let consecutiveConnFailures = 0;

const acquire = makeSemaphore(() => config.llm.maxConcurrent);

export async function assertLlmAvailable(): Promise<void> {
  return assertOpenRouterAvailable();
}

async function once(prompt: string, opts: GenerateOpts): Promise<string> {
  const release = await acquire();
  try {
    return await openRouterGenerate(prompt, opts);
  } finally {
    release();
  }
}

function recordFailureAndThrow(lastErr: Caught): never {
  if (lastErr instanceof LlmUnavailableError) throw lastErr;
  if (isConnectionError(lastErr)) {
    consecutiveConnFailures++;
    if (consecutiveConnFailures >= MAX_CONSECUTIVE_CONN_FAILURES) {
      throw new LlmUnavailableError(
        `LLM backend appears down: ${consecutiveConnFailures} consecutive connection failures. ` +
          `Last error: ${String(lastErr).slice(0, 160)}`,
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One attempt for parse-failure re-asks; still counts toward the connection-failure breaker. */
export async function generateOnce(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  try {
    const out = await once(prompt, opts);
    consecutiveConnFailures = 0;
    return out;
  } catch (err) {
    logger.warn({ err: String(err) }, "llm generate (single-shot) failed");
    return recordFailureAndThrow(err);
  }
}

export async function generate(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  let lastErr: Caught;
  for (let attempt = 0; attempt <= config.llm.maxRetries; attempt++) {
    try {
      const out = await once(prompt, opts);
      consecutiveConnFailures = 0;
      return out;
    } catch (err) {
      // A dead backend won't fix itself in 500ms.
      if (err instanceof LlmUnavailableError) throw err;
      lastErr = err;
      logger.warn({ attempt, err: String(err) }, "llm generate failed");
      if (attempt < config.llm.maxRetries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  return recordFailureAndThrow(lastErr);
}
