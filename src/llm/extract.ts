import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "../util/json.js";
import { config } from "../config.js";
import { render } from "./render.js";
import { generate } from "./client.js";
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
      const n = Number(val);
      p[key] = Number.isFinite(n) ? n : null;
    }
    const val2 = p[key];
    if (val2 === "" || val2 === "null" || val2 === "none") {
      p[key] = null;
    }
  }
  return p;
}

function parseExtractResponse(raw: string): ExtractResult {
  let parsed: JsonValue;
  try {
    parsed = JsonValueSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500) }, "extract JSON.parse failed");
    throw new Error(`extract output not JSON: ${err}`);
  }

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

  // One retry on parse failure, mirroring runGate: a fresh generation usually
  // fixes malformed JSON, and a failed extract degrades YOE classification.
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const raw = await generate(prompt, { format: "json" });
    try {
      return parseExtractResponse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
