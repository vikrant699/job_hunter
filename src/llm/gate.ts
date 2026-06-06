import { z } from "zod";
import { config } from "../config.js";
import { profile } from "../profile.js";
import { render } from "./render.js";
import { generate } from "./client.js";
import { logger } from "../logger.js";


export const GateResultSchema = z.object({
  // v2 fields — optional so v1 output still validates and downstream is unaffected.
  analysis: z.string().optional(),
  skillsMatch: z.number().min(0).max(1).optional(),
  domainFit: z.number().min(0).max(1).optional(),
  seniorityFit: z.number().min(0).max(1).optional(),
  roleTypeMatch: z.number().min(0).max(1).optional(),
  // contract consumed by verdict.ts — unchanged.
  matchScore: z.number().min(0).max(1),
  dealBreakerHit: z.string().nullable(),
  dealBreakerSeverity: z.enum(["hard", "soft"]).nullable(),
  reason: z.string(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export interface GateInput {
  jobTitle: string | null;
  companyName: string | null;
  jdText: string;
}

export interface RunGateOptions {
  /** Override the prompt template (defaults to config.prompts.relevance). Used by the eval harness. */
  promptTemplate?: string;
  /** Sampling temperature. undefined → the client default (0.2). Set 0 for
   *  deterministic, repeatable scoring in the eval harness. */
  temperature?: number;
}

/**
 * Turn a raw model response into a validated GateResult. Throws on malformed
 * JSON or schema violations (and logs the offending payload before throwing).
 */
export function parseGateResponse(raw: string): GateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ raw: raw.slice(0, 500) }, "gate JSON.parse failed");
    throw new Error(`gate output not JSON: ${err}`);
  }

  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    if (p.dealBreakerHit === "" || p.dealBreakerHit === "none" || p.dealBreakerHit === "null") {
      p.dealBreakerHit = null;
    }
    if (p.dealBreakerSeverity === "" || p.dealBreakerSeverity === "none" || p.dealBreakerSeverity === "null") {
      p.dealBreakerSeverity = null;
    }
    // If hit is null, severity must be null (model sometimes inverts this).
    if (p.dealBreakerHit === null) p.dealBreakerSeverity = null;
    // If severity is null but a hit is set, fall back to "soft" (don't silently drop).
    if (p.dealBreakerHit !== null && p.dealBreakerSeverity === null) {
      p.dealBreakerSeverity = "soft";
    }
  }

  const result = GateResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ raw: raw.slice(0, 500), issues: result.error.issues }, "gate schema validation failed");
    throw new Error("gate output failed schema validation");
  }
  return result.data;
}

export async function runGate(input: GateInput, opts: RunGateOptions = {}): Promise<GateResult> {
  const template = opts.promptTemplate ?? config.prompts.relevance;
  const prompt = render(template, {
    resume: profile.resumeText ?? "",
    hardDealBreakers: profile.hardDealBreakers,
    softDealBreakers: profile.softDealBreakers,
    jobTitle: input.jobTitle ?? "(unknown)",
    companyName: input.companyName ?? "(unknown)",
    jdText: input.jdText.slice(0, config.llm.jdMaxChars),
  });

  // One retry on parse failure: the model occasionally emits malformed JSON (a
  // wrapper key or a token runaway). A fresh generation usually fixes it, and a
  // dropped posting is a recall risk we can't afford.
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const raw = await generate(prompt, { format: "json", temperature: opts.temperature });
    try {
      return parseGateResponse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
