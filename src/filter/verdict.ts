import { profile } from "../profile.js";
import type { GateResult } from "../llm/gate.js";
import type { ExtractResult } from "../llm/extract.js";
import { SILENT_SCORE_FLOOR } from "../schemas.js";

/** green = strong match; yellow = marginal (soft deal-breaker/wrong YOE/low score), still notified; silent = hard reject, never notified. */
export type VerdictSeverity = "green" | "yellow" | "silent";

export interface VerdictDetail {
  severity: VerdictSeverity;
  reason: string;
}

/** Below this score is treated as noise and silently dropped; borderline up to matchThreshold is yellow, above is green. Defined in schemas.ts, re-exported for back-compat. */
export { SILENT_SCORE_FLOOR };

export function classifyVerdict(
  gate: GateResult,
  extract: ExtractResult | null,
  jobTitle?: string,
): VerdictDetail {
  if (gate.dealBreakerSeverity === "hard") {
    return { severity: "silent", reason: gate.dealBreakerHit ?? "hard-deal-breaker" };
  }

  // Per-profile override, else the global default.
  const silentFloor = profile.filters.silentFloor ?? SILENT_SCORE_FLOOR;
  if (gate.matchScore < silentFloor) {
    // A priority-title role is floored to yellow instead of silenced, unless it's over the hard YOE cap.
    const overYoeCap =
      extract !== null && extract.yoeMin !== null && extract.yoeMin >= profile.filters.hardYoeCap;
    const priorityTitle =
      !!jobTitle && (profile.neverSilenceTitlePatterns?.some((re) => re.test(jobTitle)) ?? false);
    if (priorityTitle && !overYoeCap) {
      return { severity: "yellow", reason: `priority-title, borderline score (${gate.matchScore.toFixed(2)})` };
    }
    return { severity: "silent", reason: `score-too-low (${gate.matchScore.toFixed(2)})` };
  }

  // Backstop to the prompt's hard deal-breaker in case the gate LLM missed the cue.
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

  // Forces yellow on unknown-YOE postings so a high gate score can't auto-green unverified seniority.
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
