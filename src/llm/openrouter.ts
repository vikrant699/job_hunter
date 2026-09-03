import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { parseRetryAfterMs, isRetryableHttpStatus } from "../util/httpRetry.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
import { LlmUnavailableError } from "./errors.js";

// OpenRouter transport (LOCAL=false). Rate limits (429) are retried here, not surfaced to client.ts's
// connection breaker, since they're traffic shaping not a dead backend; auth failures abort immediately instead.

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

/** Running prompt-cache totals for the process; logged since the cached fraction drives sweep cost. */
export function getCacheStats(): CacheStats {
  return { ...cacheStats };
}

/** Test seam - the counters are module state. */
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

// fatal = every remaining posting would fail the same way (stop the run); perCall = only this posting failed (keep going).
type StatusVerdict = "ok" | "retry" | "fatalKey" | "fatalCredits" | "fatalModel" | "perCall";

export function classifyOpenRouterStatus(status: number): StatusVerdict {
  // 401 = invalid/disabled key, 402 = out of credits, 403 = permissions/moderation (per-call, not fatal), 404 = unknown model.
  if (status === 401) return "fatalKey";
  if (status === 402) return "fatalCredits";
  if (status === 404) return "fatalModel";
  if (status === 403) return "perCall";
  if (isRetryableHttpStatus(status)) return "retry";
  return status >= 200 && status < 300 ? "ok" : "perCall";
}

// The live API answers an unknown model slug with 400 ("not a valid model ID"), not 404 - but a
// plain 400 is also what an over-long prompt returns (per-call), so the model case is picked out by message.
export function refineVerdict(verdict: StatusVerdict, status: number, body: string): StatusVerdict {
  if (verdict === "perCall" && status === 400 && /not a valid model/i.test(body)) {
    return "fatalModel";
  }
  return verdict;
}

/** Fatal verdicts, each naming the knob the operator has to change. */
function fatalMessage(verdict: StatusVerdict, status: number, body: string): string | null {
  const detail = body.slice(0, 160);
  switch (verdict) {
    case "fatalKey":
      return `OpenRouter rejected the API key (HTTP ${status}): ${detail}. Check OPENROUTER_API_KEY in .env.`;
    case "fatalCredits":
      return `OpenRouter is out of credits (HTTP ${status}): ${detail}. Top up at https://openrouter.ai/credits, or set LOCAL=true to fall back to Ollama.`;
    case "fatalModel":
      return `OpenRouter has no endpoint for model '${config.llm.openRouterModel}' (HTTP ${status}): ${detail}. Fix OPENROUTER_MODEL in .env.`;
    default:
      return null;
  }
}

const API_BASE = "https://openrouter.ai/api/v1";
const MODEL_ENDPOINTS_BASE = `${API_BASE}/models`;

// Confirms the model slug resolves; only an explicit 404 is treated as a verdict since a 5xx or
// unreachable endpoint isn't evidence the model is wrong. Public route, no auth needed.
export async function assertModelAvailable(model: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${MODEL_ENDPOINTS_BASE}/${model}/endpoints`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.warn(
      { model, err: String(err).slice(0, 120) },
      "openrouter: could not verify the model slug — continuing",
    );
    return;
  }
  if (res.status === 404) {
    throw new LlmUnavailableError(
      `OpenRouter does not serve a model called '${model}'. Fix OPENROUTER_MODEL in .env ` +
        `(check the exact slug at https://openrouter.ai/models), or set LOCAL=true to use Ollama.`,
    );
  }
  if (!res.ok) {
    logger.warn(
      { model, status: res.status },
      "openrouter: model-metadata lookup failed — continuing without verifying the slug",
    );
  }
}

/** Pre-flight: key present and accepted, and the configured model served (mirrors assertOllamaAvailable). */
export async function assertOpenRouterAvailable(): Promise<void> {
  if (config.llm.openRouterKey.trim() === "") {
    throw new LlmUnavailableError(
      "LOCAL=false but OPENROUTER_API_KEY is not set. Add it to .env, or set LOCAL=true to use Ollama.",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/key`, {
      headers: { Authorization: `Bearer ${config.llm.openRouterKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new LlmUnavailableError(
      `OpenRouter not reachable (${String(err).slice(0, 120)}). Check connectivity, or set LOCAL=true to use Ollama.`,
    );
  }
  if (res.status === 401) {
    throw new LlmUnavailableError(
      `OpenRouter rejected OPENROUTER_API_KEY (HTTP 401). Check the key in .env.`,
    );
  }
  if (res.status === 402) {
    throw new LlmUnavailableError(
      "OpenRouter reports no remaining credits. Top up at https://openrouter.ai/credits, or set LOCAL=true to use Ollama.",
    );
  }
  if (!res.ok) {
    throw new LlmUnavailableError(`OpenRouter pre-flight failed with HTTP ${res.status}.`);
  }
  await assertModelAvailable(config.llm.openRouterModel);
}

// Retries internally ONLY for 429/5xx; every other failure propagates to client.ts's retry/breaker.
// The whole prompt goes in one user message on purpose: splitting into system+user would change the
// token prefix and cost prompt-cache hits (~80% of input on a gate call).
export async function openRouterGenerate(
  prompt: string,
  opts: OpenRouterGenerateOpts,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_STATUS_RETRIES; attempt++) {
    // Wait out local network outages here so they don't trip client.ts's backend-down breaker over a hosted-provider blip.
    await awaitNetwork();
    let res: Response;
    try {
      res = await fetch(config.llm.openRouterUrl, {
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
          // Hosted equivalent of Ollama's think: false - avoids multiplying output tokens with reasoning traces.
          reasoning: { enabled: false },
        }),
        signal: AbortSignal.timeout(config.llm.timeoutMs),
      });
    } catch (err) {
      reportNetworkFailure();
      throw err;
    }
    reportNetworkSuccess();

    const verdict = classifyOpenRouterStatus(res.status);

    if (verdict === "retry" && attempt < MAX_STATUS_RETRIES) {
      const waitMs = parseRetryAfterMs(res.headers.get("retry-after"));
      logger.warn({ status: res.status, waitMs, attempt }, "openrouter throttled; backing off");
      await sleep(waitMs);
      continue;
    }

    if (verdict !== "ok") {
      const body = await res.text();
      const fatal = fatalMessage(refineVerdict(verdict, res.status, body), res.status, body);
      if (fatal !== null) throw new LlmUnavailableError(fatal);
      // Message deliberately avoids "timeout"/"aborted"/"network" so isConnectionError() doesn't misclassify it.
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
