import { logger } from "./logger.js";
import { config } from "./config.js";
import {
  selectActiveCompanies,
  markFetchSuccess,
  markFetchFailure,
  insertPostingIfNew,
  postingExists,
  selectNotifiedRoleKeys,
  updatePostingResult,
  bumpMatched,
  startRun,
  finishRun,
} from "./db/index.js";
import type { AtsAdapter } from "./ats/types.js";
import type { AdapterCompany, Company, NormalizedPosting } from "./types.js";
import { greenhouseAdapter } from "./ats/greenhouse.js";
import { leverAdapter } from "./ats/lever.js";
import { ashbyAdapter } from "./ats/ashby.js";
import { workdayAdapter } from "./ats/workday.js";
import { smartRecruitersAdapter } from "./ats/smartrecruiters.js";
import { llmScrapeAdapter } from "./scraper/llm-scrape.js";
import { playwrightScrapeAdapter } from "./scraper/playwright-scrape.js";
import { checkLocation, checkLocationFromText } from "./filter/location.js";
import { isDeniedCompany } from "./filter/denylist.js";
import { notifyKey } from "./filter/dedup.js";
import { checkTitle } from "./filter/title.js";
import { runGate } from "./llm/gate.js";
import { runExtract, type ExtractResult } from "./llm/extract.js";
import { classifyVerdict } from "./filter/verdict.js";
import { notifyPosting, notifySummary } from "./discord/notify.js";

const ATS_ADAPTERS: Record<string, AtsAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workday: workdayAdapter,
  smartrecruiters: smartRecruitersAdapter,
};

function resolveAdapter(c: Company): AtsAdapter | null {
  if (c.parsingStrategy === "llm-scrape") return llmScrapeAdapter;
  if (c.parsingStrategy === "playwright-llm-scrape") return playwrightScrapeAdapter;
  if (c.parsingStrategy === "ats-api") return ATS_ADAPTERS[c.provider] ?? null;
  return null;
}

interface RunStats {
  companiesScanned: number;
  postingsSeen: number;
  postingsNew: number;
  postingsGreen: number;
  postingsYellow: number;
  postingsTitleDenied: number;
  postingsDuplicated: number;
  errors: string[];
  /** (company|title|location) keys notified in PRIOR runs — skipped before any LLM call. */
  priorNotifyKeys: Set<string>;
  /** keys notified in THIS run — within-run dedup at notify time. */
  seenNotifyKeys: Set<string>;
}

function toAdapterCompany(c: Company): AdapterCompany {
  return {
    provider: c.provider,
    slug: c.slug,
    name: c.name,
    careersUrl: c.careersUrl,
    tenantUrl: c.tenantUrl,
    apiMeta: c.apiMeta,
  };
}

export interface ProductionTickOutcome {
  startedAtIso: string;
  endedAtIso: string;
  stats: {
    postingsSeen: number;
    postingsNew: number;
    postingsGreen: number;
    postingsYellow: number;
    postingsTitleDenied: number;
    errors: string[];
    durationMs: number;
  };
}

export async function runProductionTick(): Promise<ProductionTickOutcome> {
  const runId = startRun("production");
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  // Pre-load every (company, title, location) we've already notified so a role
  // re-listed with a fresh requisition id isn't pinged again across runs (the
  // external_id dedup misses reposts; this catches them).
  const priorNotifyKeys = new Set<string>();
  for (const r of selectNotifiedRoleKeys()) {
    priorNotifyKeys.add(notifyKey(r.company ?? "", r.title, r.location));
  }
  logger.info({ priorNotified: priorNotifyKeys.size }, "dedup: loaded prior-notified keys (cross-run)");

  const stats: RunStats = {
    companiesScanned: 0,
    postingsSeen: 0,
    postingsNew: 0,
    postingsGreen: 0,
    postingsYellow: 0,
    postingsTitleDenied: 0,
    postingsDuplicated: 0,
    errors: [],
    priorNotifyKeys,
    seenNotifyKeys: new Set(),
  };

  const allCompanies = selectActiveCompanies();
  const companies = allCompanies.filter(
    (c) =>
      c.parsingStrategy === "ats-api" ||
      c.parsingStrategy === "llm-scrape" ||
      c.parsingStrategy === "playwright-llm-scrape",
  );
  logger.info(
    { total: allCompanies.length, fetchable: companies.length },
    "production tick: companies loaded",
  );

  // Bucket by adapter identity (not provider) so llm-scrape companies share
  // one bucket regardless of their declared `source`.
  const buckets = new Map<string, { adapter: AtsAdapter; companies: Company[]; key: string }>();
  for (const c of companies) {
    const adapter = resolveAdapter(c);
    if (!adapter) continue;
    const key =
      c.parsingStrategy === "llm-scrape" ? "llm-scrape" :
      c.parsingStrategy === "playwright-llm-scrape" ? "playwright-llm-scrape" :
      c.provider;
    const existing = buckets.get(key);
    if (existing) existing.companies.push(c);
    else buckets.set(key, { adapter, companies: [c], key });
  }

  await Promise.all(
    Array.from(buckets.values()).map((b) => processBucket(b.key, b.adapter, b.companies, stats)),
  );

  const endedAt = Date.now();
  const errorBlob = stats.errors.length > 0 ? stats.errors.slice(0, 10).join("\n") : null;

  finishRun({
    id: runId,
    endedAt: new Date(endedAt).toISOString(),
    companiesScanned: stats.companiesScanned,
    postingsSeen: stats.postingsSeen,
    postingsNew: stats.postingsNew,
    postingsNotified: stats.postingsGreen + stats.postingsYellow,
    candidatesAdded: null,
    error: errorBlob,
  });

  await notifySummary({
    kind: "production",
    companiesScanned: stats.companiesScanned,
    postingsSeen: stats.postingsSeen,
    postingsNew: stats.postingsNew,
    postingsGreen: stats.postingsGreen,
    postingsYellow: stats.postingsYellow,
    postingsTitleDenied: stats.postingsTitleDenied,
    postingsDuplicated: stats.postingsDuplicated,
    durationMs: endedAt - startedAt,
    errors: stats.errors,
  });

  logger.info(
    {
      companies: stats.companiesScanned,
      postingsSeen: stats.postingsSeen,
      new: stats.postingsNew,
      green: stats.postingsGreen,
      yellow: stats.postingsYellow,
      titleDenied: stats.postingsTitleDenied,
      duplicated: stats.postingsDuplicated,
      errors: stats.errors.length,
      durationMs: endedAt - startedAt,
    },
    "production tick complete",
  );

  return {
    startedAtIso,
    endedAtIso: new Date(endedAt).toISOString(),
    stats: {
      postingsSeen: stats.postingsSeen,
      postingsNew: stats.postingsNew,
      postingsGreen: stats.postingsGreen,
      postingsYellow: stats.postingsYellow,
      postingsTitleDenied: stats.postingsTitleDenied,
      errors: stats.errors,
      durationMs: endedAt - startedAt,
    },
  };
}

async function processBucket(
  bucketKey: string,
  adapter: AtsAdapter,
  companies: Company[],
  stats: RunStats,
): Promise<void> {
  if (companies.length === 0) return;
  logger.debug({ bucket: bucketKey, count: companies.length }, "processing bucket");

  const cap = config.fetch.concurrencyPerProvider;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < companies.length) {
      const idx = cursor++;
      const company = companies[idx];
      if (!company) return;
      await processOneCompany(adapter, company, stats);
      if (config.fetch.interCallDelayMs > 0) {
        await new Promise((r) => setTimeout(r, config.fetch.interCallDelayMs));
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
}

async function processOneCompany(
  adapter: AtsAdapter,
  company: Company,
  stats: RunStats,
): Promise<void> {
  stats.companiesScanned++;

  const deny = isDeniedCompany(company.name, company.slug);
  if (deny.denied) {
    logger.debug({ company: company.name, reason: deny.reason }, "skip: services-denylist");
    return;
  }

  const adapterCompany = toAdapterCompany(company);

  let postings: NormalizedPosting[];
  try {
    postings = await adapter.listPostings(adapterCompany);
  } catch (err) {
    const msg = String(err);
    logger.warn({ company: company.name, slug: company.slug, err: msg }, "fetch failed");
    markFetchFailure(company.provider, company.slug, msg);
    stats.errors.push(`${company.provider}/${company.slug}: ${msg.slice(0, 100)}`);
    return;
  }

  markFetchSuccess(company.provider, company.slug, postings.length);

  // Worker pool within the company: HTTP work parallelizes here while Ollama
  // calls serialize inside llm/client.ts via the semaphore.
  const workers = config.fetch.workersPerCompany;
  let cursor = 0;
  async function postingWorker(): Promise<void> {
    while (cursor < postings.length) {
      const idx = cursor++;
      const posting = postings[idx];
      if (!posting) return;
      stats.postingsSeen++;
      try {
        await processOnePosting(adapter, adapterCompany, posting, company, stats);
      } catch (err) {
        logger.error(
          { company: company.name, externalId: posting.externalId, err: String(err) },
          "posting pipeline error",
        );
        stats.errors.push(`${company.slug}#${posting.externalId}: ${String(err).slice(0, 100)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => postingWorker()));
}

async function processOnePosting(
  adapter: AtsAdapter,
  adapterCompany: AdapterCompany,
  posting: NormalizedPosting,
  company: Company,
  stats: RunStats,
): Promise<void> {
  // Early location filter (only when the adapter populated location).
  if (posting.location !== null && posting.location !== "") {
    const loc = checkLocation(posting.location, posting.isRemote);
    if (!loc.accept) return;
  }

  // Pre-fetch dedup — saves a JD HTTP call if we've seen this exact posting id.
  if (postingExists(posting.provider, posting.externalId)) return;

  // Cross-run dedup BEFORE any LLM work: a role with the same
  // (company, title, location) already notified in a prior run is a re-listing
  // (fresh requisition id). Skip it outright rather than spend gate + extract
  // calls to re-derive a verdict we'd only drop at notify time.
  const dupKey = notifyKey(posting.companyName ?? company.name, posting.jobTitle, posting.location);
  if (stats.priorNotifyKeys.has(dupKey)) {
    stats.postingsDuplicated++;
    return;
  }

  // Cheap title-deny — runs before JD fetch so Workday/llm-scrape save the
  // round trip too. Doesn't write to DB; each tick re-checks.
  const titleCheck = checkTitle(posting.jobTitle);
  if (titleCheck.skip) {
    stats.postingsTitleDenied++;
    logger.debug(
      { company: company.name, title: posting.jobTitle, pattern: titleCheck.reason },
      "title-deny: pre-filter dropped before LLM",
    );
    return;
  }

  // Lazy JD fetch for adapters whose listing lacks the body (Workday, llm-scrape).
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

  // Late location filter when the listing had no location metadata: scan the
  // title (where scraped postings often carry the location, e.g. "… Sydney, NSW")
  // plus the JD head. Runs even when the JD is empty so a foreign title is caught.
  if (posting.location === null || posting.location === "") {
    const loc = checkLocationFromText(posting.jobTitle ?? "", posting.jdText ?? "");
    if (!loc.accept) return;
  }

  const inserted = insertPostingIfNew(posting);
  if (!inserted) return; // race: another worker beat us; leave it for next tick
  stats.postingsNew++;

  if (!posting.jdText) {
    updatePostingResult({
      provider: posting.provider,
      externalId: posting.externalId,
      llmRelevant: 0,
      llmReason: "no-jd",
      llmConfidence: null,
      yoeMin: null,
      yoeMax: null,
      dropStage: "no-jd",
      notifiedAt: null,
    });
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
    // Couldn't score even after the gate's retry (malformed model output). Don't
    // silently drop — an unscored posting could be a real match. Surface it as a
    // yellow "review manually" notification so recall isn't quietly lost.
    // (Intentionally exempt from per-run dedup below — gate-errors are rare and
    // we'd rather surface each one than risk collapsing a real match.)
    let notifiedAt: string | null = null;
    try {
      await notifyPosting({
        posting,
        severity: "yellow",
        matchScore: 0,
        reason: "gate-error: couldn't score automatically — review manually",
        yoeMin: null,
        yoeMax: null,
        fallbackCareersUrl: company.careersUrl,
      });
      notifiedAt = new Date().toISOString();
      stats.postingsYellow++;
    } catch (notifyErr) {
      logger.error({ err: String(notifyErr), company: posting.companyName }, "gate-error notify failed");
    }
    logger.warn(
      { company: company.name, title: posting.jobTitle, err: String(err).slice(0, 120) },
      "gate-error → yellow (manual review)",
    );
    updatePostingResult({
      provider: posting.provider,
      externalId: posting.externalId,
      llmRelevant: 0,
      llmReason: `gate-error: ${String(err).slice(0, 120)}`,
      llmConfidence: null,
      yoeMin: null,
      yoeMax: null,
      dropStage: "gate-error",
      notifiedAt,
    });
    return;
  }

  // Hard deal-breaker short-circuits before extract.
  if (gateResult.dealBreakerSeverity === "hard") {
    updatePostingResult({
      provider: posting.provider,
      externalId: posting.externalId,
      llmRelevant: 0,
      llmReason: gateResult.dealBreakerHit ?? "hard-deal-breaker",
      llmConfidence: gateResult.matchScore,
      yoeMin: null,
      yoeMax: null,
      dropStage: "hard-deal-breaker",
      notifiedAt: null,
    });
    return;
  }

  let extractResult: ExtractResult | null;
  try {
    extractResult = await runExtract(posting.jdText);
  } catch (err) {
    extractResult = null;
    logger.warn({ company: company.name, err: String(err) }, "extract failed, continuing without YOE");
  }

  const verdict = classifyVerdict(gateResult, extractResult);

  if (verdict.severity === "silent") {
    updatePostingResult({
      provider: posting.provider,
      externalId: posting.externalId,
      llmRelevant: 0,
      llmReason: verdict.reason,
      llmConfidence: gateResult.matchScore,
      yoeMin: extractResult?.yoeMin ?? null,
      yoeMax: extractResult?.yoeMax ?? null,
      dropStage: "silent",
      notifiedAt: null,
    });
    return;
  }

  // Within-run dedup: an identical role already pinged earlier in THIS run is
  // recorded but not re-notified (cross-run repeats were already skipped before
  // the gate). dupKey was computed above; reserve it before the await so two
  // concurrent workers can't both notify the same role.
  if (stats.seenNotifyKeys.has(dupKey)) {
    stats.postingsDuplicated++;
    updatePostingResult({
      provider: posting.provider,
      externalId: posting.externalId,
      llmRelevant: verdict.severity === "green" ? 1 : 0,
      llmReason: `duplicate: ${verdict.reason}`,
      llmConfidence: gateResult.matchScore,
      yoeMin: extractResult?.yoeMin ?? null,
      yoeMax: extractResult?.yoeMax ?? null,
      dropStage: "duplicate",
      notifiedAt: null,
    });
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

  updatePostingResult({
    provider: posting.provider,
    externalId: posting.externalId,
    llmRelevant: verdict.severity === "green" ? 1 : 0,
    llmReason: verdict.reason,
    llmConfidence: gateResult.matchScore,
    yoeMin: extractResult?.yoeMin ?? null,
    yoeMax: extractResult?.yoeMax ?? null,
    dropStage: verdict.severity === "green" ? null : "yellow",
    notifiedAt,
  });
}
