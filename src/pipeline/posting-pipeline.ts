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
import { notifyKey } from "../filter/dedup.js";
import { checkTitle } from "../filter/title.js";
import { runGate } from "../llm/gate.js";
import { runExtract, type ExtractResult } from "../llm/extract.js";
import { OllamaUnavailableError } from "../llm/client.js";
import { classifyVerdict, SILENT_SCORE_FLOOR } from "../filter/verdict.js";
import { profile } from "../profile.js";
import type { RunContext } from "./index.js";

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
  });
}

/**
 * A posting dropped before or during LLM scoring: llmRelevant is always 0,
 * yoeMin/yoeMax are null unless an extract result is supplied, and it was
 * never notified. Covers the no-jd, gate-error, hard-deal-breaker, and silent
 * drop stages, which all share this shape and differ only in reason/
 * confidence/dropStage/yoe.
 */
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

/**
 * A posting that reached a verdict (green/yellow) and either got deduped
 * against an already-notified role this run, or was itself notified (or
 * attempted-and-failed to notify). llmRelevant is 1 only for green.
 */
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

export async function processOnePosting(
  adapter: AtsAdapter,
  adapterCompany: AdapterCompany,
  posting: NormalizedPosting,
  company: Company,
  stats: RunContext,
): Promise<void> {
  if (posting.location !== null && posting.location !== "") {
    const loc = checkLocation(posting.location, posting.isRemote);
    if (!loc.accept) return;
  }

  if (postingExists(posting.provider, posting.externalId, stats.profileId)) return;

  // Cross-run dedup: skip re-listings (same company/title/location notified before)
  // before spending gate + extract calls, since we'd only drop them at notify time.
  const dupKey = notifyKey(posting.companyName ?? company.name, posting.jobTitle, posting.location);
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
    try {
      posting.jdText = await adapter.fetchJd(adapterCompany, posting);
    } catch (err) {
      stats.jdFetchFailed++;
      logger.warn(
        { company: company.name, externalId: posting.externalId, err: String(err) },
        "fetchJd failed; skipping",
      );
      return;
    }
  }

  // Late location filter from title/JD/URL when listing had no location metadata.
  if (posting.location === null || posting.location === "") {
    const loc = checkLocationFromText(posting.jobTitle ?? "", posting.jdText ?? "", undefined, posting.jobUrl);
    if (!loc.accept) return;
  }

  const inserted = insertPostingIfNew(posting, stats.profileId);
  if (!inserted) return; // race: another worker beat us; leave it for next tick
  stats.postingsNew++;

  if (!posting.jdText) {
    writePostingResult(posting, droppedResult("no-jd", "no-jd"), stats.profileId);
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
    // Backend down (not a per-posting failure) — abort the whole run rather
    // than storing this and the next several thousand postings as gate-errors.
    if (err instanceof OllamaUnavailableError) throw err;
    // Couldn't score even after the gate's retry (malformed model output). A
    // score-less posting is treated as 0 and NOT sent to Discord — surfacing
    // every unparseable result would flood the feed with noise. We still store
    // it with dropStage "gate-error" so the error rate stays auditable (e.g.
    // the qwen "missing reason field" retries), without notifying anyone.
    logger.warn(
      { company: company.name, title: posting.jobTitle, err: String(err).slice(0, 120) },
      "gate-error → stored, not notified",
    );
    writePostingResult(
      posting,
      droppedResult(`gate-error: ${String(err).slice(0, 120)}`, "gate-error"),
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

  // Below the silent floor, classifyVerdict drops the posting before YOE is
  // ever consulted — running extract would be a wasted LLM call AND would
  // evict the gate prompt's KV prefix cache (the resume) between gate calls.
  // Last full run this skipped ~4k of ~4.6k extract calls.
  let extractResult: ExtractResult | null = null;
  if (gateResult.matchScore >= (profile.filters.silentFloor ?? SILENT_SCORE_FLOOR)) {
    try {
      extractResult = await runExtract(posting.jdText);
    } catch (err) {
      if (err instanceof OllamaUnavailableError) throw err;
      logger.warn({ company: company.name, err: String(err) }, "extract failed, continuing without YOE");
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

  // Within-run dedup: reserve dupKey before the await so concurrent workers
  // can't both notify the same role.
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
