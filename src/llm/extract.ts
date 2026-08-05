import { z } from "zod";
import { parseJsonOrThrow } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { config } from "../config.js";
import { render } from "./render.js";
import { generate, generateOnce } from "./client.js";
import { logger } from "../logger.js";

export const ExtractResultSchema = z.object({
  yoeMin: z.number().nullable(),
  yoeMax: z.number().nullable(),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

function normalize(parsed: JsonValue): JsonValue {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const p: { [k: string]: JsonValue } = parsed;
  for (const key of ["yoeMin", "yoeMax"]) {
    const val = p[key];
    if (typeof val === "string") {
      // Empty/placeholder strings mean "unspecified" — they must become null,
      // not 0 (Number("") === 0), or verdict.ts would treat the YOE as known.
      const s = val.trim().toLowerCase();
      if (s === "" || s === "null" || s === "none") {
        p[key] = null;
      } else {
        const n = Number(s);
        p[key] = Number.isFinite(n) ? n : null;
      }
    }
  }
  return p;
}

/** Parse + normalize one raw model response. Pure — unit tested. */
export function parseExtractResponse(raw: string): ExtractResult {
  const parsed: JsonValue = parseJsonOrThrow(raw, "extract");

  const result = ExtractResultSchema.safeParse(normalize(parsed));
  if (!result.success) {
    logger.warn(
      { raw: raw.slice(0, 500), issues: result.error.issues },
      "extract schema validation failed"
    );
    throw new Error("extract output failed schema validation");
  }
  return result.data;
}

export async function runExtract(jdText: string): Promise<ExtractResult> {
  const prompt = render(config.prompts.extract, { jdText: jdText.slice(0, config.llm.jdMaxChars) });

  // One re-ask on parse failure, mirroring runGate: a fresh generation usually
  // fixes malformed JSON, and a failed extract degrades YOE classification.
  //
  // Worst case: 3 HTTP calls from the first attempt's generate() (transport
  // retries) + 1 from the generateOnce() re-ask = 4, not 6.
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const raw = attempt === 0
      ? await generate(prompt, { format: "json" })
      : await generateOnce(prompt, { format: "json" });
    try {
      return parseExtractResponse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
