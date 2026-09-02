import { config } from "../config.js";
import { logger } from "../logger.js";
import { makeSemaphore } from "../util/semaphore.js";
import { sleep } from "../util/sleep.js";
import { LlmUnavailableError } from "./errors.js";
import { assertOllamaAvailable, ollamaGenerate } from "./ollama.js";
import { assertOpenRouterAvailable, openRouterGenerate } from "./openrouter.js";

interface GenerateOpts {
  format?: "json";
  temperature?: number | undefined;
}

// Connection-level failure (server unreachable), distinct from a per-posting model/output error.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
export function isConnectionError(err: unknown): boolean {
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

// Trips after this many *consecutive* connection failures; any success resets the count.
const MAX_CONSECUTIVE_CONN_FAILURES = 5;
let consecutiveConnFailures = 0;

const acquire = makeSemaphore(() => config.llm.maxConcurrent);

/** The same semaphore generate()/generateOnce() use, exposed for llm/embed.ts so an embed call shares the
 *  concurrency budget (and, on Ollama, the GPU) instead of running alongside gate/extract calls unbounded. */
export const acquireLlmSlot = acquire;

/** Pre-flight for whichever backend LOCAL selects; throws LlmUnavailableError so a bad backend fails fast instead of flooding gate-errors. */
export async function assertLlmAvailable(): Promise<void> {
  return config.llm.local ? assertOllamaAvailable() : assertOpenRouterAvailable();
}

function transportGenerate(prompt: string, opts: GenerateOpts): Promise<string> {
  return config.llm.local ? ollamaGenerate(prompt, opts) : openRouterGenerate(prompt, opts);
}

async function once(prompt: string, opts: GenerateOpts): Promise<string> {
  const release = await acquire();
  try {
    return await transportGenerate(prompt, opts);
  } finally {
    release();
  }
}

// Shared post-failure bookkeeping for generate()/generateOnce(); trips the breaker on the run instead of returning.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function recordFailureAndThrow(lastErr: unknown): never {
  // Already-classified backend failure is fatal on its own; don't re-wrap or count it.
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

/** Exactly one attempt (no transport-retry loop), for re-ask attempts after a parse failure in gate.ts/extract.ts; still participates in the connection-failure breaker. */
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
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.llm.maxRetries; attempt++) {
    try {
      const out = await once(prompt, opts);
      consecutiveConnFailures = 0;
      return out;
    } catch (err) {
      // A dead/misconfigured backend won't fix itself in 500ms - abort now instead of burning retries.
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
