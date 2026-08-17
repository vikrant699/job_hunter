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

/** Parses a raw LLM response as JSON against JsonValueSchema; on failure logs the payload and throws a labeled error. */
export function parseJsonOrThrow(raw: string, label: string): JsonValue {
  try {
    return JsonValueSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500) }, `${label} JSON.parse failed`);
    throw new Error(`${label} output not JSON: ${err}`);
  }
}

/** JSON.parse that returns a validated JsonValue, or null on any failure (malformed JSON, or a schema mismatch). */
export function tryParseJson(text: string): JsonValue | null {
  try {
    return JsonValueSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Returns the value at `key` if it's a plain JSON object, else null; omit `key` to re-narrow `node` itself. Narrows nested ATS API responses one level at a time. */
export function getObj(node: JsonValue | undefined | null, key?: string): Record<string, JsonValue> | null {
  const target = key === undefined ? node : (typeof node === "object" && node !== null && !Array.isArray(node) ? node[key] : undefined);
  if (typeof target !== "object" || target === null || Array.isArray(target)) return null;
  return target;
}
