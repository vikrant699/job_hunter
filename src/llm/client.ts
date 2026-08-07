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

// A connection-level failure (server down / unreachable / not responding) as
// opposed to a model or output error, which is per-posting and recoverable.
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
    s.includes("aborted") || // our own timeout fires when the server stops responding
    s.includes("timeout")
  );
}

// Trip the breaker after this many *consecutive* connection failures. Any
// successful generate resets the count, so isolated transients don't trip it.
const MAX_CONSECUTIVE_CONN_FAILURES = 5;
let consecutiveConnFailures = 0;

// Ollama serializes on the GPU, so the abort timeout signal is created AFTER
// the semaphore slot is held — otherwise deep queues caused tail calls to
// time out before generation began. (Both transports create their own signal.)
const acquire = makeSemaphore(() => config.llm.maxConcurrent);

/**
 * Pre-flight for whichever backend LOCAL selects: Ollama reachable with the
 * model pulled, or an OpenRouter key that is present and accepted. Throws
 * LlmUnavailableError with an actionable message. Call this before a production
 * tick so we fail fast instead of storing a flood of gate-errors against a
 * backend that was never up (root cause of 2026-06-17).
 */
export async function assertLlmAvailable(): Promise<void> {
  return config.llm.local ? assertOllamaAvailable() : assertOpenRouterAvailable();
}

// Read at call time, not at module load: config.ts evaluates process.env on
// import, so a lazily-read flag is the only kind a test can influence.
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

// Shared post-failure bookkeeping for both generate() (after its retries are
// exhausted) and generateOnce() (after its single attempt fails): trips the
// breaker once enough *consecutive* connection failures pile up so the run
// aborts instead of silently producing thousands of gate-errors against a
// dead backend. Throws — never returns normally.
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
function recordFailureAndThrow(lastErr: unknown): never {
  // An already-classified backend failure (bad key, unreachable host) must not
  // be re-wrapped or counted — it is fatal on its own.
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

/**
 * Exactly one attempt — no transport-retry loop. Still goes through the
 * semaphore/timeout in once() and still participates in the consecutive-
 * connection-failure breaker (a success resets the counter; a connection-
 * shaped failure increments it and can still trip LlmUnavailableError).
 *
 * Intended for re-ask attempts after a parse failure (see gate.ts/extract.ts):
 * a malformed-JSON response needs a fresh generation, not another 3-call
 * transport-retry cascade layered on top of the first attempt's own retries.
 */
export async function generateOnce(prompt: string, opts: GenerateOpts = {}): Promise<string> {
  try {
    const out = await once(prompt, opts);
    consecutiveConnFailures = 0; // a success means the backend is alive
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
      consecutiveConnFailures = 0; // a success means the backend is alive
      return out;
    } catch (err) {
      // A dead/misconfigured backend will not fix itself in 500ms — abort now
      // rather than burning the retry budget on it.
      if (err instanceof LlmUnavailableError) throw err;
      lastErr = err;
      logger.warn({ attempt, err: String(err) }, "llm generate failed");
      if (attempt < config.llm.maxRetries) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  // All retries exhausted. If this looks like the backend being down (not a
  // one-off bad response), trip the breaker once enough calls fail in a row so
  // the run aborts instead of silently producing thousands of gate-errors.
  return recordFailureAndThrow(lastErr);
}
