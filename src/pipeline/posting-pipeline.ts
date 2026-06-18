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
import { notifyPosting } from "../discord/notify.js";
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
      logger.warn(
        { company: company.name, externalId: posting.externalId, err: String(err) },
        "fetchJd failed; skipping",
      );
      return;
    }
  }

  // Late location filter from title/JD text when listing had no location metadata.
  if (posting.location === null || posting.location === "") {
    const loc = checkLocationFromText(posting.jobTitle ?? "", posting.jdText ?? "");
    if (!loc.accept) return;
  }

  const inserted = insertPostingIfNew(posting, stats.profileId);
  if (!inserted) return; // race: another worker beat us; leave it for next tick
  stats.postingsNew++;

  if (!posting.jdText) {
    writePostingResult(posting, {
      llmRelevant: 0,
      llmReason: "no-jd",
      llmConfidence: null,
      yoeMin: null,
      yoeMax: null,
      dropStage: "no-jd",
      notifiedAt: null,
    }, stats.profileId);
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
    writePostingResult(posting, {
      llmRelevant: 0,
      llmReason: `gate-error: ${String(err).slice(0, 120)}`,
      llmConfidence: null,
      yoeMin: null,
      yoeMax: null,
      dropStage: "gate-error",
      notifiedAt: null,
    }, stats.profileId);
    return;
  }

  if (gateResult.dealBreakerSeverity === "hard") {
    writePostingResult(posting, {
      llmRelevant: 0,
      llmReason: gateResult.dealBreakerHit ?? "hard-deal-breaker",
      llmConfidence: gateResult.matchScore,
      yoeMin: null,
      yoeMax: null,
      dropStage: "hard-deal-breaker",
      notifiedAt: null,
    }, stats.profileId);
    return;
  }

  // Below the silent floor, classifyVerdict drops the posting before YOE is
  // ever consulted — running extract would be a wasted LLM call AND would
  // evict the gate prompt's KV prefix cache (the resume) between gate calls.
  // Last full run this skipped ~4k of ~4.6k extract calls.
  let extractResult: ExtractResult | null = null;
  if (gateResult.matchScore >= SILENT_SCORE_FLOOR) {
    try {
      extractResult = await runExtract(posting.jdText);
    } catch (err) {
      if (err instanceof OllamaUnavailableError) throw err;
      logger.warn({ company: company.name, err: String(err) }, "extract failed, continuing without YOE");
    }
  }

  const verdict = classifyVerdict(gateResult, extractResult);

  if (verdict.severity === "silent") {
    writePostingResult(posting, {
      llmRelevant: 0,
      llmReason: verdict.reason,
      llmConfidence: gateResult.matchScore,
      yoeMin: extractResult?.yoeMin ?? null,
      yoeMax: extractResult?.yoeMax ?? null,
      dropStage: "silent",
      notifiedAt: null,
    }, stats.profileId);
    return;
  }

  // Within-run dedup: reserve dupKey before the await so concurrent workers
  // can't both notify the same role.
  if (stats.seenNotifyKeys.has(dupKey)) {
    stats.postingsDuplicated++;
    writePostingResult(posting, {
      llmRelevant: verdict.severity === "green" ? 1 : 0,
      llmReason: `duplicate: ${verdict.reason}`,
      llmConfidence: gateResult.matchScore,
      yoeMin: extractResult?.yoeMin ?? null,
      yoeMax: extractResult?.yoeMax ?? null,
      dropStage: "duplicate",
      notifiedAt: null,
    }, stats.profileId);
    return;
  }
  stats.seenNotifyKeys.add(dupKey);

  let notifiedAt: string | null = null;
  try {
    await notifyPosting({
      posting,
      severity: verdict.severity,
      matchScore: gateResult.matchScore,
      reason: verdict.reason,
      yoeMin: extractResult?.yoeMin ?? null,
      yoeMax: extractResult?.yoeMax ?? null,
      fallbackCareersUrl: company.careersUrl,
    });
    notifiedAt = new Date().toISOString();
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
      `${verdict.severity} → Discord`,
    );
  } catch (err) {
    const msg = String(err);
    logger.error({ err: msg, company: posting.companyName, title: posting.jobTitle }, "Discord notify failed");
    stats.errors.push(`discord ${company.slug}#${posting.externalId}: ${msg.slice(0, 100)}`);
  }

  writePostingResult(posting, {
    llmRelevant: verdict.severity === "green" ? 1 : 0,
    llmReason: verdict.reason,
    llmConfidence: gateResult.matchScore,
    yoeMin: extractResult?.yoeMin ?? null,
    yoeMax: extractResult?.yoeMax ?? null,
    dropStage: verdict.severity === "green" ? null : "yellow",
    notifiedAt,
  }, stats.profileId);
}
