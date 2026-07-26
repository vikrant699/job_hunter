import { z } from "zod";
import { logger } from "../logger.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Parse a raw LLM response as JSON and validate it against JsonValueSchema.
 * On failure, logs the offending payload (capped to 500 chars, the most
 * informative of the call sites this replaces) and throws a labeled error
 * so callers/logs can tell which LLM call produced the bad output.
 */
export function parseJsonOrThrow(raw: string, label: string): JsonValue {
  try {
    return JsonValueSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500) }, `${label} JSON.parse failed`);
    throw new Error(`${label} output not JSON: ${err}`);
  }
}

/**
 * JSON.parse that returns a validated JsonValue, or null on ANY failure
 * (malformed JSON text, or — vanishingly rarely, since valid JSON only ever
 * produces JsonValue-shaped values — a JsonValueSchema mismatch). Kills the
 * `let parsed: unknown; try { parsed = JSON.parse(...) } catch { ... }`
 * idiom repeated across the ATS adapters (rule 3: library-returned unknown
 * flows straight into zod on one expression, no hand-annotated variable).
 */
export function tryParseJson(text: string): JsonValue | null {
  try {
    return JsonValueSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Return the value at `key` if it is a plain JSON object (not an array or
 * null), else null. Omit `key` to narrow `node` itself instead of a property
 * of it — call as `getObj(x)` (no key) to re-narrow `x` itself, used after
 * pulling a value out of a JsonValue. Used to narrow nested ATS API responses
 * one level at a time without repeating the typeof/Array.isArray dance at
 * every level.
 */
export function getObj(node: JsonValue | undefined | null, key?: string): Record<string, JsonValue> | null {
  const target = key === undefined ? node : (typeof node === "object" && node !== null && !Array.isArray(node) ? node[key] : undefined);
  if (typeof target !== "object" || target === null || Array.isArray(target)) return null;
  return target;
}
