import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { parseRetryAfterMs, isRetryableHttpStatus } from "../util/httpRetry.js";
import { awaitNetwork, reportNetworkFailure, reportNetworkSuccess } from "../util/connectivity.js";
import { LlmUnavailableError } from "./errors.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

const OpenRouterResponseSchema = z.object({
  provider: z.string().optional(),
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

const MAX_STATUS_RETRIES = 3;
const CACHE_LOG_EVERY = 100;

export interface CacheStats {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  /** More than one entry means the pin isn't holding and the cache is being split. */
  providers: Record<string, number>;
}

const cacheStats: CacheStats = { calls: 0, promptTokens: 0, cachedTokens: 0, providers: {} };

export function getCacheStats(): CacheStats {
  return { ...cacheStats, providers: { ...cacheStats.providers } };
}

export function resetCacheStats(): void {
  cacheStats.calls = 0;
  cacheStats.promptTokens = 0;
  cacheStats.cachedTokens = 0;
  cacheStats.providers = {};
}

export function cachedPercent(stats: CacheStats): number {
  return stats.promptTokens > 0 ? Math.round((100 * stats.cachedTokens) / stats.promptTokens) : 0;
}

function recordUsage(data: z.infer<typeof OpenRouterResponseSchema>): void {
  const usage = data.usage;
  cacheStats.calls++;
  cacheStats.promptTokens += usage?.prompt_tokens ?? 0;
  cacheStats.cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const provider = data.provider ?? "unknown";
  cacheStats.providers[provider] = (cacheStats.providers[provider] ?? 0) + 1;
  if (cacheStats.calls % CACHE_LOG_EVERY === 0) {
    logger.info({ ...getCacheStats(), cachedPct: cachedPercent(cacheStats) }, "openrouter prompt-cache hit rate");
  }
}

type StatusVerdict = "ok" | "retry" | "fatalKey" | "fatalCredits" | "fatalModel" | "perCall";

export function classifyOpenRouterStatus(status: number): StatusVerdict {
  // 401 invalid/disabled key, 402 out of credits, 403 permissions/moderation (per-call), 404 unknown model.
  if (status === 401) return "fatalKey";
  if (status === 402) return "fatalCredits";
  if (status === 404) return "fatalModel";
  if (status === 403) return "perCall";
  if (isRetryableHttpStatus(status)) return "retry";
  return status >= 200 && status < 300 ? "ok" : "perCall";
}

// An unknown model slug answers 400, not 404, but a plain 400 is also an over-long prompt (per-call), so match by message.
export function refineVerdict(verdict: StatusVerdict, status: number, body: string): StatusVerdict {
  if (verdict === "perCall" && status === 400 && /not a valid model/i.test(body)) {
    return "fatalModel";
  }
  return verdict;
}

function fatalMessage(verdict: StatusVerdict, status: number, body: string): string | null {
  const detail = body.slice(0, 160);
  switch (verdict) {
    case "fatalKey":
      return `OpenRouter rejected the API key (HTTP ${status}): ${detail}. Check OPENROUTER_API_KEY in .env.`;
    case "fatalCredits":
      return `OpenRouter is out of credits (HTTP ${status}): ${detail}. Top up at https://openrouter.ai/credits.`;
    case "fatalModel":
      return `OpenRouter has no endpoint for model '${config.llm.openRouterModel}' (HTTP ${status}): ${detail}. Fix OPENROUTER_MODEL in .env.`;
    default:
      return null;
  }
}

const API_BASE = "https://openrouter.ai/api/v1";
const MODEL_ENDPOINTS_BASE = `${API_BASE}/models`;

// The slug before "/" is what the provider.order request field takes.
const ModelEndpointsSchema = z.object({
  data: z.object({ endpoints: z.array(z.object({ tag: z.string().optional() })).default([]) }),
});

/** OpenRouter writes some as "open-inference" but routes on "openinference", so hyphens are dropped. */
function providerSlug(tag: string): string {
  return tag.split("/")[0]?.replace(/-/g, "").toLowerCase() ?? "";
}

export function servingProviders(pinned: readonly string[], body: JsonValue): string[] | null {
  const parsed = ModelEndpointsSchema.safeParse(body);
  if (!parsed.success) return null;
  const served = new Set(parsed.data.data.endpoints.map((e) => providerSlug(e.tag ?? "")));
  return pinned.filter((p) => served.has(p.replace(/-/g, "").toLowerCase()));
}

// Only an explicit 404 is a slug verdict; a 5xx or unreachable endpoint isn't evidence. Public route, no auth.
export async function assertModelAvailable(model: string, pinned: readonly string[] = config.llm.openRouterProviders): Promise<void> {
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
        `(check the exact slug at https://openrouter.ai/models).`,
    );
  }
  if (!res.ok) {
    logger.warn(
      { model, status: res.status },
      "openrouter: model-metadata lookup failed — continuing without verifying the slug",
    );
    return;
  }
  if (pinned.length === 0) return;
  const serving = servingProviders(pinned, JsonValueSchema.parse(await res.json()));
  if (serving === null) {
    logger.warn({ model }, "openrouter: endpoint list unparseable — continuing without verifying the provider pin");
    return;
  }
  // With allow_fallbacks=false every gate call would fail, so this aborts pre-flight.
  if (serving.length === 0) {
    throw new LlmUnavailableError(
      `None of OPENROUTER_PROVIDERS (${pinned.join(", ")}) serve '${model}' on OpenRouter. ` +
        `Pick slugs from https://openrouter.ai/${model}/providers or clear OPENROUTER_PROVIDERS.`,
    );
  }
  logger.info({ model, pinned, serving }, "openrouter: provider pin verified");
}

export async function assertOpenRouterAvailable(): Promise<void> {
  if (config.llm.openRouterKey.trim() === "") {
    throw new LlmUnavailableError(
      "OPENROUTER_API_KEY is not set. Add it to .env (create a key at https://openrouter.ai/keys).",
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
      `OpenRouter not reachable (${String(err).slice(0, 120)}). Check connectivity.`,
    );
  }
  if (res.status === 401) {
    throw new LlmUnavailableError(
      `OpenRouter rejected OPENROUTER_API_KEY (HTTP 401). Check the key in .env.`,
    );
  }
  if (res.status === 402) {
    throw new LlmUnavailableError(
      "OpenRouter reports no remaining credits. Top up at https://openrouter.ai/credits.",
    );
  }
  if (!res.ok) {
    throw new LlmUnavailableError(`OpenRouter pre-flight failed with HTTP ${res.status}.`);
  }
  await assertModelAvailable(config.llm.openRouterModel);
}

// Retries only 429/5xx; other failures propagate to client.ts's retry/breaker.
// Whole prompt in one user message: a system+user split changes the token prefix and costs prompt-cache hits.
export async function openRouterGenerate(
  prompt: string,
  opts: OpenRouterGenerateOpts,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_STATUS_RETRIES; attempt++) {
    // Wait out local outages here so they don't trip the backend-down breaker.
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
          // Reasoning traces multiply output tokens.
          reasoning: { enabled: false },
          // No fallback: the prompt cache is per provider.
          ...(config.llm.openRouterProviders.length > 0
            ? { provider: { order: config.llm.openRouterProviders, allow_fallbacks: false } }
            : {}),
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
      // Avoids "timeout"/"aborted"/"network" so isConnectionError() doesn't misclassify it.
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = OpenRouterResponseSchema.parse(await res.json());
    recordUsage(data);
    const content = data.choices[0]?.message.content;
    if (typeof content !== "string" || content === "") {
      throw new Error("OpenRouter returned no message content");
    }
    return content;
  }
  throw new Error(`OpenRouter HTTP retries exhausted after ${MAX_STATUS_RETRIES + 1} attempts`);
}
