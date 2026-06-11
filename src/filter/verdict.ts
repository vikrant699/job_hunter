import { profile } from "../profile.js";
import type { GateResult } from "../llm/gate.js";
import type { ExtractResult } from "../llm/extract.js";

/**
 * Tri-state verdict.
 *   green  → strong match; send to Discord with green sidebar
 *   yellow → marginal match (soft deal-breaker, wrong YOE, low score); send to Discord
 *            with yellow sidebar so user can visually filter
 *   silent → hard reject (services / staffing / fresher / location / score below noise);
 *            do not notify at all
 */
export type Severity = "green" | "yellow" | "silent";

export interface VerdictDetail {
  severity: Severity;
  reason: string;
}

/**
 * Lower bound below which we treat the score as noise and silently drop.
 * Raised 0.4 -> 0.65 (user decision 2026-06-11) after the first full-volume run:
 * the 0.4-0.65 band was ~76% of yellow notifications and almost entirely noise.
 * Replayed against that run: costs 3 of 30 former greens (scored 0.6-0.65).
 * Borderline 0.65-matchThreshold is yellow; >= matchThreshold (0.8) is green.
 */
const SILENT_SCORE_FLOOR = 0.65;

export function classifyVerdict(gate: GateResult, extract: ExtractResult | null): VerdictDetail {
  if (gate.dealBreakerSeverity === "hard") {
    return { severity: "silent", reason: gate.dealBreakerHit ?? "hard-deal-breaker" };
  }

  if (gate.matchScore < SILENT_SCORE_FLOOR) {
    return { severity: "silent", reason: `score-too-low (${gate.matchScore.toFixed(2)})` };
  }

  // Hard YOE cap — silent. Backstop to the prompt's hard deal-breaker; runs
  // even when the gate LLM missed the cue.
  if (
    extract &&
    extract.yoeMin !== null &&
    extract.yoeMin >= profile.filters.hardYoeCap
  ) {
    return {
      severity: "silent",
      reason: `needs ${extract.yoeMin}+ years (hard cap ${profile.filters.hardYoeCap})`,
    };
  }

  if (gate.dealBreakerSeverity === "soft") {
    return { severity: "yellow", reason: `soft: ${gate.dealBreakerHit ?? "soft-deal-breaker"}` };
  }

  // When yoeAcceptUnspecified is false, force yellow on unknown-YOE postings
  // so a high gate score can't auto-green a role whose seniority is unverified.
  if (!profile.filters.yoeAcceptUnspecified) {
    const yoeUnknown = !extract || (extract.yoeMin === null && extract.yoeMax === null);
    if (yoeUnknown) {
      return { severity: "yellow", reason: "yoe-unknown" };
    }
  }

  if (extract) {
    const Y = profile.filters.candidateYoe;
    if (extract.yoeMin !== null && Y < extract.yoeMin) {
      return { severity: "yellow", reason: `under-qualified (needs ${extract.yoeMin}+)` };
    }
    if (extract.yoeMax !== null && Y > extract.yoeMax) {
      return { severity: "yellow", reason: `over-qualified (max ${extract.yoeMax})` };
    }
  }

  if (gate.matchScore >= profile.filters.matchThreshold) {
    return { severity: "green", reason: gate.reason };
  }
  return { severity: "yellow", reason: `borderline-score (${gate.matchScore.toFixed(2)})` };
}
