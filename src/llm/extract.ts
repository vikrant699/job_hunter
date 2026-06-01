import { z } from "zod";
import { config } from "../config.js";
import { render } from "./render.js";
import { generate } from "./client.js";
import { logger } from "../logger.js";
import { JD_MAX_CHARS } from "./gate.js";

export const ExtractResultSchema = z.object({
  yoeMin: z.number().nullable(),
  yoeMax: z.number().nullable(),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

function normalize(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const p = parsed as Record<string, unknown>;
  for (const key of ["yoeMin", "yoeMax"]) {
    if (typeof p[key] === "string") {
      const n = Number(p[key]);
      p[key] = Number.isFinite(n) ? n : null;
    }
    if (p[key] === "" || p[key] === "null" || p[key] === "none") {
      p[key] = null;
    }
  }
  return p;
}

export async function runExtract(jdText: string): Promise<ExtractResult> {
  const prompt = render(config.prompts.extract, { jdText: jdText.slice(0, JD_MAX_CHARS) });
  const raw = await generate(prompt, { format: "json" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
