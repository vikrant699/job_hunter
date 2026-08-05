import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { makeSemaphore } from "../util/semaphore.js";
import { sleep } from "../util/sleep.js";

interface GenerateOpts {
  format?: "json";
  temperature?: number | undefined;
}

const OllamaResponseSchema = z.object({ response: z.string().optional() });
const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string() })).default([]),
});

/**
 * Thrown when the Ollama backend is unreachable — distinct from a per-posting
 * gate/extract failure. Callers (pipeline, scheduler) re-throw this instead of
 * swallowing it as a "gate-error", so the run aborts loudly rather than churning
 * thousands of bogus 0-scores against a dead backend.
 */
export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
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
// time out before generation began.
const acquire = makeSemaphore(() => config.llm.maxConcurrent);

/**
 * Pre-flight: confirm Ollama is reachable AND the configured model is pulled.
 * Throws OllamaUnavailableError with an actionable message otherwise. Call this
 * before a production tick so we fail fast instead of storing a flood of
 * gate-errors against a backend that was never up (root cause of 2026-06-17).
 */
export async function assertOllamaAvailable(): Promise<void> {
  let names: string[];
  try {
    const res = await fetch(`${config.llm.ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    names = OllamaTagsSchema.parse(await res.json()).models.map((m) => m.name);
  } catch (err) {
    throw new OllamaUnavailableError(
      `Ollama not reachable at ${config.llm.ollamaHost} (${String(err).slice(0, 120)}). ` +
        `Start it with 'ollama serve' before running the bot.`,
    );
  }
  if (!names.includes(config.llm.model)) {
    throw new OllamaUnavailableError(
      `Ollama is up but the configured model '${config.llm.model}' is not pulled ` +
        `(available: ${names.join(", ") || "none"}). Run 'ollama pull ${config.llm.model}'.`,
    );
  }
}

async function once(prompt: string, opts: GenerateOpts): Promise<string> {
  const release = await acquire();
  try {
    const res = await fetch(`${config.llm.ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.llm.model,
        prompt,
        stream: false,
        format: opts.format,
        // Disable "thinking" on reasoning models (qwen3, etc.) — the reasoning
        // tokens break strict-JSON parsing and blow the timeout. No-op on plain
        // instruct models like qwen2.5.
        think: false,
        options: { temperature: opts.temperature ?? 0.2, num_ctx: config.llm.numCtx },
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = OllamaResponseSchema.parse(await res.json());
    if (typeof data.response !== "string") {
      throw new Error("Ollama returned no 'response' field");
    }
    return data.response;
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
  if (isConnectionError(lastErr)) {
    consecutiveConnFailures++;
    if (consecutiveConnFailures >= MAX_CONSECUTIVE_CONN_FAILURES) {
      throw new OllamaUnavailableError(
        `Ollama appears down: ${consecutiveConnFailures} consecutive connection failures. ` +
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
 * shaped failure increments it and can still trip OllamaUnavailableError).
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
    logger.warn({ err: String(err) }, "ollama generate (single-shot) failed");
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
      lastErr = err;
      logger.warn({ attempt, err: String(err) }, "ollama generate failed");
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
