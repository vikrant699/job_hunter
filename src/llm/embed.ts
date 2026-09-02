// Shadow-mode embedding entry point: measures resume<->posting cosine similarity, never acts on it.
// Mirrors client.ts's dispatch shape exactly (LOCAL read at call time, same shared semaphore) so the
// feature behaves identically on both backends; per-backend model knobs are opt-in (unset = feature off).
import { config } from "../config.js";
import { logger } from "../logger.js";
import { acquireLlmSlot } from "./client.js";
import { ollamaEmbed } from "./ollama.js";
import { openRouterEmbed } from "./openrouter.js";

/** Same cap gate.ts/extract.ts apply to JD text, applied here to keep one call cheap and bounded. */
const MAX_INPUT_CHARS = 8000;

export interface EmbedResult {
  vector: number[];
  modelTag: string;
}

/** The active backend's embed model, or undefined when its knob is unset (feature off for that backend). */
function activeEmbedModel(): string | undefined {
  return config.llm.local ? config.llm.ollamaEmbedModel : config.llm.openRouterEmbedModel;
}

/** The tag that would be stamped on a vector embedded right now, or null when embedding is off — pure and
 *  synchronous, so callers can gate on "is embedding enabled" without spending a network call. */
export function embedModelTag(): string | null {
  const model = activeEmbedModel();
  if (model === undefined || model === "") return null;
  return config.llm.local ? `ollama:${model}` : `openrouter:${model}`;
}

function transportEmbed(text: string, model: string): Promise<number[]> {
  return config.llm.local ? ollamaEmbed(text, model) : openRouterEmbed(text, model);
}

/** Embeds `text` on whichever backend LOCAL selects. Returns null when the active backend's embed-model
 *  knob is unset (feature off) or when the transport call fails — shadow mode must never fail a posting
 *  or the run, so every transport error is swallowed here after a warn. */
export async function embedText(text: string): Promise<EmbedResult | null> {
  const model = activeEmbedModel();
  if (model === undefined || model === "") return null;

  const truncated = text.slice(0, MAX_INPUT_CHARS);
  // Same semaphore gate/extract calls use, so LOCAL never holds two models' peak VRAM at once and
  // OpenRouter stays within its existing concurrency budget.
  const release = await acquireLlmSlot();
  try {
    const vector = await transportEmbed(truncated, model);
    return { vector, modelTag: config.llm.local ? `ollama:${model}` : `openrouter:${model}` };
  } catch (err) {
    logger.warn({ err: String(err) }, "embed failed; shadow-mode skip");
    return null;
  } finally {
    release();
  }
}

/** Cosine similarity of two vectors. 0 (with a warn) on a dimension mismatch — similarity scores from
 *  different model tags must never be compared, and a mismatch here means they were anyway. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    logger.warn({ aLen: a.length, bLen: b.length }, "embed: cosine dimension mismatch");
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
