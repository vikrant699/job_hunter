import { logger } from "../logger.js";
import {
  insertPostingIfNew,
  postingExists,
  updatePostingResult,
  bumpMatched,
} from "../db/index.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, Company, NormalizedPosting } from "../types.js";
import { checkLocation, checkLocationFromText } from "../filter/location.js";
import type { LocationCheck } from "../filter/location.js";
import { notifyKey } from "../filter/dedup.js";
import { checkTitle } from "../filter/title.js";
import { isJunkJd } from "../filter/junkJd.js";
import { runGate } from "../llm/gate.js";
import { runExtract } from "../llm/extract.js";
import type { ExtractResult } from "../llm/extract.js";
import { LlmUnavailableError } from "../llm/errors.js";
import { classifyVerdict, SILENT_SCORE_FLOOR } from "../filter/verdict.js";
import { extractSalary } from "../filter/salary.js";
import { profile } from "../profile.js";
import { sleep } from "../util/sleep.js";
import { describeError, isInfrastructureFault } from "../util/errorCause.js";
import { parseStatedYoeMin } from "../filter/yoe.js";
import type { RunContext } from "./index.js";
// Type-only: the scheduler owns the policy and is this function's only production caller, so importing the shape back creates no runtime dependency on it.
import type { TransportRetryPolicy } from "./scheduler.js";

interface PostingResultPatch {
  llmRelevant: number | null;
  llmReason: string | null;
  llmConfidence: number | null;
  yoeMin: number | null;
  yoeMax: number | null;
  dropStage: string | null;
  notifiedAt: string | null;
}

function writePostingResult(posting: NormalizedPosting, patch: PostingResultPatch, profileId: string): void {
  // Mechanical (no-LLM), storage-only: skipped for no-jd/junk-jd writes (jdText empty); never affects verdict/filtering.
  const salary = posting.jdText ? extractSalary(posting.jdText) : null;
  updatePostingResult({
    provider: posting.provider,
    externalId: posting.externalId,
    profileId,
    llmRelevant: patch.llmRelevant,
    llmReason: patch.llmReason,
    llmConfidence: patch.llmConfidence,
    yoeMin: patch.yoeMin,
    yoeMax: patch.yoeMax,
    dropStage: patch.dropStage,
    notifiedAt: patch.notifiedAt,
    salaryMin: salary?.annualMin ?? null,
    salaryMax: salary?.annualMax ?? null,
    salaryCurrency: salary?.currency ?? null,
    salaryPeriod: salary?.period ?? null,
  });
}

/** A posting dropped before or during LLM scoring: llmRelevant always 0, never notified. Shared shape for no-jd, gate-error, hard-deal-breaker, and silent drop stages. */
export function droppedResult(
  llmReason: string,
  dropStage: string,
  opts: { llmConfidence?: number | null; yoeMin?: number | null; yoeMax?: number | null } = {},
): PostingResultPatch {
  return {
    llmRelevant: 0,
    llmReason,
    llmConfidence: opts.llmConfidence ?? null,
    yoeMin: opts.yoeMin ?? null,
    yoeMax: opts.yoeMax ?? null,
    dropStage,
    notifiedAt: null,
  };
}

/** A posting that reached a verdict (green/yellow): deduped, notified, or attempted-and-failed. llmRelevant is 1 only for green. */
export function verdictResult(
  severity: "green" | "yellow",
  llmReason: string,
  llmConfidence: number | null,
  opts: { yoeMin?: number | null; yoeMax?: number | null; dropStage?: string | null; notifiedAt?: string | null } = {},
): PostingResultPatch {
  return {
    llmRelevant: severity === "green" ? 1 : 0,
    llmReason,
    llmConfidence,
    yoeMin: opts.yoeMin ?? null,
    yoeMax: opts.yoeMax ?? null,
    dropStage: opts.dropStage ?? null,
    notifiedAt: opts.notifiedAt ?? null,
  };
}

/** Location verdict once the JD is fetched; a late-resolved `location` (e.g. ralphlauren, from the detail page) must still hit the strict metadata check, not the no-metadata fallback, or a foreign role could slip past. */
export function lateLocationCheck(posting: NormalizedPosting): LocationCheck {
  if (posting.location !== null && posting.location !== "") {
    return checkLocation(posting.location, posting.isRemote);
  }
  return checkLocationFromText(posting.jobTitle, posting.jdText, undefined, posting.jobUrl);
}

export async function processOnePosting(
  adapter: AtsAdapter,
  adapterCompany: AdapterCompany,
  posting: NormalizedPosting,
  company: Company,
  stats: RunContext,
  retry: TransportRetryPolicy,
): Promise<void> {
  if (posting.location !== null && posting.location !== "") {
    const loc = checkLocation(posting.location, posting.isRemote);
    if (!loc.accept) return;
  }

  if (postingExists(posting.provider, posting.externalId, stats.profileId)) return;

  // Cross-run dedup: skip re-listings (same company/title/location notified before) before spending gate + extract calls, since we'd only drop them at notify time.
  const dupKey = notifyKey(posting.companyName, posting.jobTitle, posting.location);
  if (stats.priorNotifyKeys.has(dupKey)) {
    stats.postingsDuplicated++;
    return;
  }

  // Title-deny before JD fetch so Workday/llm-scrape save the round trip.
  const titleCheck = checkTitle(posting.jobTitle);
  if (titleCheck.skip) {
    stats.postingsTitleDenied++;
    logger.debug(
      { company: company.name, title: posting.jobTitle, pattern: titleCheck.reason },
      "title-deny: pre-filter dropped before LLM",
    );
    return;
  }

  if (!posting.jdText && adapter.fetchJd) {
    const fetchJd = adapter.fetchJd;
    // Retry infrastructure failures: a JD lost to a network blip is skipped before insertPostingIfNew and only reappears next run; board-shaped errors (404/403/schema) are not retried - the host answered.
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
    let jdErr: unknown;
    for (let attempt = 0; attempt <= retry.retries; attempt++) {
      try {
        posting.jdText = await fetchJd(adapterCompany, posting);
        jdErr = undefined;
        break;
      } catch (err) {
        jdErr = err;
        if (!isInfrastructureFault(err) || attempt === retry.retries) break;
        await sleep(retry.baseDelayMs * 2 ** attempt);
      }
    }
    if (jdErr !== undefined) {
      stats.jdFetchFailed++;
      logger.warn(
        { company: company.name, externalId: posting.externalId, err: describeError(jdErr) },
        "fetchJd failed; skipping",
      );
      return;
    }
  }

  // Late location filter: strict metadata if the adapter resolved a location during fetchJd, otherwise the title/JD/URL heuristic.
  if (!lateLocationCheck(posting).accept) return;

  const inserted = insertPostingIfNew(posting, stats.profileId);
  if (!inserted) return; // race: another worker beat us; leave it for next tick
  stats.postingsNew++;

  if (!posting.jdText) {
    writePostingResult(posting, droppedResult("no-jd", "no-jd"), stats.profileId);
    return;
  }

  // Non-empty but content-free (vendor placeholder, dots-only): same outcome as no-jd, but junk preserved in the reason for auditability.
  if (isJunkJd(posting.jdText)) {
    writePostingResult(
      posting,
      droppedResult(`junk-jd: ${posting.jdText.trim().slice(0, 60)}`, "no-jd"),
      stats.profileId,
    );
    return;
  }

  // Hard YOE deal-breaker, applied deterministically before a gate call. Only fires on an explicitly stated bar; ambiguous cases still reach the gate.
  const statedYoeMin = parseStatedYoeMin(posting.jdText);
  if (statedYoeMin !== null && statedYoeMin >= profile.filters.hardYoeCap) {
    stats.postingsYoeDenied++;
    logger.debug(
      { company: company.name, title: posting.jobTitle, statedYoeMin, cap: profile.filters.hardYoeCap },
      "yoe-deny: pre-filter dropped before LLM",
    );
    writePostingResult(
      posting,
      droppedResult(`needs ${statedYoeMin}+ years (hard cap ${profile.filters.hardYoeCap})`, "yoe-deny"),
      stats.profileId,
    );
    return;
  }

  let gateResult;
  try {
    gateResult = await runGate({
      jobTitle: posting.jobTitle,
      companyName: posting.companyName,
      jdText: posting.jdText,
    });
  } catch (err) {
    // Backend down (not a per-posting failure) - abort the whole run rather than storing thousands of postings as gate-errors.
    if (err instanceof LlmUnavailableError) throw err;
    // Malformed model output even after the gate's retry: store as dropStage "gate-error" (auditable) without notifying anyone.
    logger.warn(
      { company: company.name, title: posting.jobTitle, err: describeError(err).slice(0, 120) },
      "gate-error → stored, not notified",
    );
    writePostingResult(
      posting,
      droppedResult(`gate-error: ${describeError(err).slice(0, 120)}`, "gate-error"),
      stats.profileId,
    );
    return;
  }

  if (gateResult.dealBreakerSeverity === "hard") {
    writePostingResult(
      posting,
      droppedResult(gateResult.dealBreakerHit ?? "hard-deal-breaker", "hard-deal-breaker", {
        llmConfidence: gateResult.matchScore,
      }),
      stats.profileId,
    );
    return;
  }

  // Below the silent floor, skip extract entirely: it would be a wasted LLM call and would evict the gate prompt's KV prefix cache between gate calls.
  let extractResult: ExtractResult | null = null;
  if (gateResult.matchScore >= (profile.filters.silentFloor ?? SILENT_SCORE_FLOOR)) {
    try {
      extractResult = await runExtract(posting.jdText);
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      logger.warn({ company: company.name, err: describeError(err) }, "extract failed, continuing without YOE");
    }
  }

  const verdict = classifyVerdict(gateResult, extractResult, posting.jobTitle);

  if (verdict.severity === "silent") {
    writePostingResult(
      posting,
      droppedResult(verdict.reason, "silent", {
        llmConfidence: gateResult.matchScore,
        yoeMin: extractResult?.yoeMin ?? null,
        yoeMax: extractResult?.yoeMax ?? null,
      }),
      stats.profileId,
    );
    return;
  }

  // Within-run dedup: check-and-reserve is atomic here (no await between has() and add()), so two workers can't both record the same role.
  if (stats.seenNotifyKeys.has(dupKey)) {
    stats.postingsDuplicated++;
    writePostingResult(
      posting,
      verdictResult(verdict.severity, `duplicate: ${verdict.reason}`, gateResult.matchScore, {
        yoeMin: extractResult?.yoeMin ?? null,
        yoeMax: extractResult?.yoeMax ?? null,
        dropStage: "duplicate",
        notifiedAt: null,
      }),
      stats.profileId,
    );
    return;
  }
  stats.seenNotifyKeys.add(dupKey);

  const notifiedAt: string = new Date().toISOString();
  if (verdict.severity === "green") stats.postingsGreen++;
  else stats.postingsYellow++;
  bumpMatched(posting.provider, posting.companySlug);
  logger.info(
    {
      company: posting.companyName,
      title: posting.jobTitle,
      severity: verdict.severity,
      score: gateResult.matchScore,
    },
    `${verdict.severity} → outreach`,
  );

  writePostingResult(
    posting,
    verdictResult(verdict.severity, verdict.reason, gateResult.matchScore, {
      yoeMin: extractResult?.yoeMin ?? null,
      yoeMax: extractResult?.yoeMax ?? null,
      dropStage: verdict.severity === "green" ? null : "yellow",
      notifiedAt,
    }),
    stats.profileId,
  );
}
