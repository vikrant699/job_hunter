import { z } from "zod";
import { config } from "../config.js";
import { profile } from "../profile.js";
import { render } from "./render.js";
import { generate, generateOnce } from "./client.js";
import { logger } from "../logger.js";
import { parseJsonOrThrow } from "../util/json.js";
import type { JsonValue } from "../util/json.js";


export const GateResultSchema = z.object({
  // v2 fields, optional so v1 output still validates.
  analysis: z.string().optional(),
  skillsMatch: z.number().min(0).max(1).optional(),
  domainFit: z.number().min(0).max(1).optional(),
  seniorityFit: z.number().min(0).max(1).optional(),
  roleTypeMatch: z.number().min(0).max(1).optional(),
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
  /** Override the prompt template (defaults to config.prompts.gate); used by the eval harness. */
  promptTemplate?: string;
  /** Sampling temperature; undefined uses the client default (0.2), 0 for deterministic eval-harness scoring. */
  temperature?: number | undefined;
}

/** Turn a raw model response into a validated GateResult; throws on malformed JSON or schema violations. */
export function parseGateResponse(raw: string): GateResult {
  let parsed: JsonValue = parseJsonOrThrow(raw, "gate");

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const p: { [k: string]: JsonValue } = parsed;
    // Model sometimes omits these keys entirely; treat absent/empty/"none"/"null" as null.
    if (p["dealBreakerHit"] === undefined || p["dealBreakerHit"] === "" || p["dealBreakerHit"] === "none" || p["dealBreakerHit"] === "null") {
      p["dealBreakerHit"] = null;
    }
    if (p["dealBreakerSeverity"] === undefined || p["dealBreakerSeverity"] === "" || p["dealBreakerSeverity"] === "none" || p["dealBreakerSeverity"] === "null") {
      p["dealBreakerSeverity"] = null;
    }
    // Model sometimes inverts hit/severity nullness; normalize both directions.
    if (p["dealBreakerHit"] === null) p["dealBreakerSeverity"] = null;
    if (p["dealBreakerHit"] !== null && p["dealBreakerSeverity"] === null) {
      p["dealBreakerSeverity"] = "soft";
    }
    // reason is display-only and sometimes omitted; backfill so a missing reason never fails validation.
    if (typeof p["reason"] !== "string" || p["reason"] === "") {
      const analysis = typeof p["analysis"] === "string" ? p["analysis"] : "";
      const score = typeof p["matchScore"] === "number" ? p["matchScore"].toFixed(2) : "?";
      p["reason"] = analysis !== "" ? analysis.slice(0, 200) : `auto: matchScore ${score}`;
    }
    parsed = p;
  }

  const result = GateResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ raw: raw.slice(0, 500), issues: result.error.issues }, "gate schema validation failed");
    throw new Error("gate output failed schema validation");
  }
  return result.data;
}

export async function runGate(input: GateInput, opts: RunGateOptions = {}): Promise<GateResult> {
  // Precedence: eval-harness override > per-profile rubric > global default.
  const template = opts.promptTemplate ?? profile.gatePrompt ?? config.prompts.gate;
  const prompt = render(template, {
    resume: profile.resumeText ?? "",
    hardDealBreakers: profile.hardDealBreakers,
    softDealBreakers: profile.softDealBreakers,
    jobTitle: input.jobTitle ?? "(unknown)",
    companyName: input.companyName ?? "(unknown)",
    jdText: input.jdText.slice(0, config.llm.jdMaxChars),
  });

  // Up to 2 re-asks on parse failure, each a single generateOnce() call instead of a full transport-retry cascade - worst case 5 HTTP calls, not 9.
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const raw = attempt === 0
      ? await generate(prompt, { format: "json", temperature: opts.temperature })
      : await generateOnce(prompt, { format: "json", temperature: opts.temperature });
    try {
      return parseGateResponse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
