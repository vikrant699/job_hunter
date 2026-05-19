import { z } from "zod";
import { config } from "../config.js";
import { profile } from "../profile.js";
import { render } from "./render.js";
import { generate } from "./client.js";
import { logger } from "../logger.js";

export const GateResultSchema = z.object({
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

export async function runGate(input: GateInput): Promise<GateResult> {
  const prompt = render(config.prompts.relevance, {
    summary: profile.summary,
    hardDealBreakers: profile.hardDealBreakers,
    softDealBreakers: profile.softDealBreakers,
    jobTitle: input.jobTitle ?? "(unknown)",
    companyName: input.companyName ?? "(unknown)",
    jdText: input.jdText,
  });

  const raw = await generate(prompt, { format: "json" });

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
    // If severity is null but hit is set, fall back to "soft" (don't silently drop).
    if (p.dealBreakerHit !== null && p.dealBreakerSeverity === null) {
      p.dealBreakerSeverity = "soft";
    }
  }

  const result = GateResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { raw: raw.slice(0, 500), issues: result.error.issues },
      "gate schema validation failed"
    );
    throw new Error("gate output failed schema validation");
  }
  return result.data;
}
