import { z } from "zod";
import { config } from "../config.js";
import { LlmUnavailableError } from "./errors.js";

// Nothing here retries; that's client.ts's job, so both transports share identical retry/breaker semantics.

const OllamaResponseSchema = z.object({ response: z.string().optional() });
const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string() })).default([]),
});

export interface OllamaGenerateOpts {
  format?: "json";
  temperature?: number | undefined;
}

/** Pre-flight: confirm Ollama is reachable and the configured model is pulled. */
export async function assertOllamaAvailable(): Promise<void> {
  let names: string[];
  try {
    const res = await fetch(`${config.llm.ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    names = OllamaTagsSchema.parse(await res.json()).models.map((m) => m.name);
  } catch (err) {
    throw new LlmUnavailableError(
      `Ollama not reachable at ${config.llm.ollamaHost} (${String(err).slice(0, 120)}). ` +
        `Start it with 'ollama serve' before running the bot.`,
    );
  }
  if (!names.includes(config.llm.model)) {
    throw new LlmUnavailableError(
      `Ollama is up but the configured model '${config.llm.model}' is not pulled ` +
        `(available: ${names.join(", ") || "none"}). Run 'ollama pull ${config.llm.model}'.`,
    );
  }
}

/** One generation attempt against Ollama. Throws on any non-2xx or empty body. */
export async function ollamaGenerate(prompt: string, opts: OllamaGenerateOpts): Promise<string> {
  const res = await fetch(`${config.llm.ollamaHost}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.llm.model,
      prompt,
      stream: false,
      format: opts.format,
      // Disable "thinking": reasoning tokens break strict-JSON parsing and blow the timeout; no-op on non-reasoning models.
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
}
