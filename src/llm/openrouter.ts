import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { parseRetryAfterMs, isRetryableHttpStatus } from "../util/httpRetry.js";
import { LlmUnavailableError } from "./errors.js";

/**
 * OpenRouter transport (LOCAL=false). OpenAI-compatible chat-completions.
 *
 * Rate limits are handled HERE rather than being surfaced to client.ts, because
 * a 429 is normal traffic shaping, not a dead backend - letting it reach the
 * consecutive-connection-failure breaker would abort a sweep mid-run. Auth
 * failures do the opposite and abort immediately: there is no point scoring
 * 40,000 postings against a bad key.
 */

const OpenRouterResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});

export interface OpenRouterGenerateOpts {
  format?: "json";
  temperature?: number | undefined;
}

/** Attempts made *inside* the transport for a rate-limited / transient-5xx response. */
const MAX_STATUS_RETRIES = 3;
/** How often to emit the running cache hit-rate. */
const CACHE_LOG_EVERY = 100;

export interface CacheStats {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
}

const cacheStats: CacheStats = { calls: 0, promptTokens: 0, cachedTokens: 0 };

/**
 * Running prompt-cache totals for the process. The cached fraction is what
 * decides whether a month of sweeps costs ~$5 or ~$19, so it is logged rather
 * than left to the invoice to reveal.
 */
export function getCacheStats(): CacheStats {
  return { ...cacheStats };
}

/** Test seam — the counters are module state, same as the client's breaker. */
export function resetCacheStats(): void {
  cacheStats.calls = 0;
  cacheStats.promptTokens = 0;
  cacheStats.cachedTokens = 0;
}

function recordUsage(usage: z.infer<typeof OpenRouterResponseSchema>["usage"]): void {
  cacheStats.calls++;
  cacheStats.promptTokens += usage?.prompt_tokens ?? 0;
  cacheStats.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
  if (cacheStats.calls % CACHE_LOG_EVERY === 0) {
    const pct = cacheStats.promptTokens > 0
      ? Math.round((100 * cacheStats.cachedTokens) / cacheStats.promptTokens)
      : 0;
    logger.info(
      {
        calls: cacheStats.calls,
        promptTokens: cacheStats.promptTokens,
        cachedTokens: cacheStats.cachedTokens,
        cachedPct: pct,
      },
      "openrouter prompt-cache hit rate",
    );
  }
}

/**
 * Pre-flight: key present and accepted. Mirrors assertOllamaAvailable's
 * fail-fast role so a bad key surfaces in seconds, before any scraping.
 */
export async function assertOpenRouterAvailable(): Promise<void> {
  if (config.llm.openRouterKey.trim() === "") {
    throw new LlmUnavailableError(
      "LOCAL=false but OPENROUTER_API_KEY is not set. Add it to .env, or set LOCAL=true to use Ollama.",
    );
  }
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${config.llm.openRouterKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new LlmUnavailableError(
      `OpenRouter not reachable (${String(err).slice(0, 120)}). Check connectivity, or set LOCAL=true to use Ollama.`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new LlmUnavailableError(
      `OpenRouter rejected OPENROUTER_API_KEY (HTTP ${res.status}). Check the key in .env.`,
    );
  }
  if (!res.ok) {
    throw new LlmUnavailableError(`OpenRouter pre-flight failed with HTTP ${res.status}.`);
  }
}

/**
 * One logical generation. Retries internally ONLY for 429/5xx; every other
 * failure propagates to client.ts, which owns the transport retry and breaker.
 *
 * The whole rendered prompt goes in a single user message on purpose: splitting
 * it into system+user would change the token prefix and cost us prompt-cache
 * hits, which are ~80% of the input on a gate call.
 */
export async function openRouterGenerate(
  prompt: string,
  opts: OpenRouterGenerateOpts,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_STATUS_RETRIES; attempt++) {
    const res = await fetch(config.llm.openRouterUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.openRouterKey}`,
      },
      body: JSON.stringify({
        model: config.llm.openRouterModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: opts.temperature ?? 0.2,
        ...(opts.format === "json" ? { response_format: { type: "json_object" } } : {}),
        // Reasoning traces would multiply output tokens on every posting; the
        // gate wants a score and a reason, not a chain of thought. This is the
        // hosted equivalent of Ollama's `think: false`.
        reasoning: { enabled: false },
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });

    // A bad/exhausted key is not a per-posting failure — stop the whole run.
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      throw new LlmUnavailableError(
        `OpenRouter rejected the API key (HTTP ${res.status}): ${body.slice(0, 160)}. Check OPENROUTER_API_KEY in .env.`,
      );
    }

    if (isRetryableHttpStatus(res.status) && attempt < MAX_STATUS_RETRIES) {
      const waitMs = parseRetryAfterMs(res.headers.get("retry-after"));
      logger.warn({ status: res.status, waitMs, attempt }, "openrouter throttled; backing off");
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      // Deliberately free of the words isConnectionError() sniffs for
      // ("timeout", "aborted", "network"): an HTTP-status failure must not be
      // mistaken for the backend being down and trip the breaker.
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = OpenRouterResponseSchema.parse(await res.json());
    recordUsage(data.usage);
    const content = data.choices[0]?.message.content;
    if (typeof content !== "string" || content === "") {
      throw new Error("OpenRouter returned no message content");
    }
    return content;
  }
  throw new Error(`OpenRouter HTTP retries exhausted after ${MAX_STATUS_RETRIES + 1} attempts`);
}
