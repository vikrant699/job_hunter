import { logger } from "../logger.js";
import {
  selectActiveCompanies,
  selectNotifiedRoleKeys,
  finishRun,
  startRun,
  applyDormancy,
} from "../db/index.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, Company } from "../types.js";
import { notifyKey } from "../filter/dedup.js";
import { startProgressHeartbeat } from "../discord/progress.js";
import { resolveAdapter } from "../ats/registry.js";
import { assertLlmAvailable } from "../llm/client.js";
import { LlmUnavailableError } from "../llm/errors.js";
import { profile } from "../profile.js";
import { describeError } from "../util/errorCause.js";
import { processBucket, runDeferredTransportPass } from "./scheduler.js";

export interface DeferredBoard {
  company: Company;
  adapter: AtsAdapter;
  err: string;
}

export interface RunContext {
  companiesScanned: number;
  postingsSeen: number;
  postingsNew: number;
  postingsGreen: number;
  postingsYellow: number;
  postingsTitleDenied: number;
  postingsYoeDenied: number;
  postingsDuplicated: number;
  jdFetchFailed: number;
  noJdRechecked: number;
  noJdRecovered: number;
  gateErrorRetried: number;
  errors: string[];
  failedCompanies: Array<{ provider: string; slug: string; reason: string }>;
  transportRetried: number;
  transportDeferred: DeferredBoard[];
  transportRecovered: number;
  priorNotifyKeys: Set<string>;
  seenNotifyKeys: Set<string>;
  profileId: string;
  bucketProgress: Map<string, { total: number; scanned: number }>;
}

export function toAdapterCompany(c: Company): AdapterCompany {
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
  runId: number;
  startedAtIso: string;
  endedAtIso: string;
  stats: {
    companiesScanned: number;
    postingsSeen: number;
    postingsNew: number;
    postingsGreen: number;
    postingsYellow: number;
    postingsTitleDenied: number;
    postingsYoeDenied: number;
    postingsDuplicated: number;
    jdFetchFailed: number;
    transportRetried: number;
    transportRecovered: number;
    errors: string[];
    failedCompanies: Array<{ provider: string; slug: string; reason: string }>;
    durationMs: number;
  };
}

export async function runProductionTick(): Promise<ProductionTickOutcome> {
  await assertLlmAvailable();

  const profileId = profile.id ?? "default";
  const runId = startRun("production", profileId);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const priorNotifyKeys = new Set<string>();
  for (const r of selectNotifiedRoleKeys(profileId)) {
    priorNotifyKeys.add(notifyKey(r.company ?? "", r.title, r.location));
  }
  logger.info({ priorNotified: priorNotifyKeys.size }, "dedup: loaded prior-notified keys (cross-run)");

  const stats: RunContext = {
    companiesScanned: 0,
    postingsSeen: 0,
    postingsNew: 0,
    postingsGreen: 0,
    postingsYellow: 0,
    postingsTitleDenied: 0,
    postingsYoeDenied: 0,
    postingsDuplicated: 0,
    jdFetchFailed: 0,
    noJdRechecked: 0,
    noJdRecovered: 0,
    gateErrorRetried: 0,
    errors: [],
    failedCompanies: [],
    transportRetried: 0,
    transportDeferred: [],
    transportRecovered: 0,
    priorNotifyKeys,
    seenNotifyKeys: new Set(),
    profileId,
    bucketProgress: new Map(),
  };

  const allCompanies = selectActiveCompanies();
  const companies = allCompanies.filter(
    (c) =>
      c.parsingStrategy === "ats-api" ||
      c.parsingStrategy === "llm-scrape" ||
      c.parsingStrategy === "playwright-llm-scrape",
  );
  logger.info(
    {
      total: allCompanies.length,
      fetchable: companies.length,
      excluded: allCompanies.length - companies.length,
    },
    "production tick: companies loaded",
  );

  const buckets = new Map<string, { adapter: AtsAdapter; companies: Company[]; key: string }>();
  for (const c of companies) {
    const adapter = resolveAdapter(c);
    if (!adapter) {
      logger.error({ provider: c.provider, slug: c.slug, strategy: c.parsingStrategy }, "no adapter resolves for company - skipped");
      stats.errors.push(`${c.provider}/${c.slug}: no adapter`);
      stats.failedCompanies.push({ provider: c.provider, slug: c.slug, reason: "config" });
      continue;
    }
    const key =
      c.parsingStrategy === "llm-scrape" ? "llm-scrape" :
      c.parsingStrategy === "playwright-llm-scrape" ? "playwright-llm-scrape" :
      c.provider;
    const existing = buckets.get(key);
    if (existing) existing.companies.push(c);
    else buckets.set(key, { adapter, companies: [c], key });
  }

  for (const b of buckets.values()) {
    stats.bucketProgress.set(b.key, { total: b.companies.length, scanned: 0 });
  }
  const stopHeartbeat = startProgressHeartbeat({ stats, startedAt, profileId });

  let runClosed = false;
  const closeRun = (error: string | null): void => {
    if (runClosed) return;
    runClosed = true;
    finishRun({
      id: runId,
      endedAt: new Date().toISOString(),
      companiesScanned: stats.companiesScanned,
      postingsSeen: stats.postingsSeen,
      postingsNew: stats.postingsNew,
      postingsNotified: stats.postingsGreen + stats.postingsYellow,
      candidatesAdded: null,
      error,
    });
  };

  try {
    await Promise.all(
      Array.from(buckets.values()).map((b) => processBucket(b.key, b.adapter, b.companies, stats)),
    );
    await runDeferredTransportPass(stats);
  } catch (err) {
    const reason = err instanceof LlmUnavailableError ? `aborted: ${err.message}` : `crashed: ${describeError(err).slice(0, 300)}`;
    if (err instanceof LlmUnavailableError) {
      logger.error({ err: err.message }, "run aborted: LLM backend became unavailable mid-run");
    }
    closeRun(reason);
    throw err;
  } finally {
    stopHeartbeat();
  }

  const parked = applyDormancy();
  if (parked > 0) {
    logger.info({ companies: parked }, "dormancy: zero-yield scrape companies parked (weekly recheck)");
  }

  const endedAt = Date.now();
  const errorBlob = stats.errors.length > 0 ? stats.errors.slice(0, 10).join("\n") : null;

  closeRun(errorBlob);

  logger.info(
    {
      companies: stats.companiesScanned,
      postingsSeen: stats.postingsSeen,
      new: stats.postingsNew,
      green: stats.postingsGreen,
      yellow: stats.postingsYellow,
      titleDenied: stats.postingsTitleDenied,
      yoeDenied: stats.postingsYoeDenied,
      duplicated: stats.postingsDuplicated,
      jdFetchFailed: stats.jdFetchFailed,
      transportRetried: stats.transportRetried,
      transportRecovered: stats.transportRecovered,
      errors: stats.errors.length,
      boardsWithIssues: stats.failedCompanies.length,
      durationMs: endedAt - startedAt,
    },
    "production tick complete",
  );
  logger.info({ rechecked: stats.noJdRechecked, recovered: stats.noJdRecovered, gateErrorRetried: stats.gateErrorRetried }, "recheck: stored no-jd / gate-error postings re-processed");

  return {
    runId,
    startedAtIso,
    endedAtIso: new Date(endedAt).toISOString(),
    stats: {
      companiesScanned: stats.companiesScanned,
      postingsSeen: stats.postingsSeen,
      postingsNew: stats.postingsNew,
      postingsGreen: stats.postingsGreen,
      postingsYellow: stats.postingsYellow,
      postingsTitleDenied: stats.postingsTitleDenied,
      postingsYoeDenied: stats.postingsYoeDenied,
      postingsDuplicated: stats.postingsDuplicated,
      jdFetchFailed: stats.jdFetchFailed,
      transportRetried: stats.transportRetried,
      transportRecovered: stats.transportRecovered,
      errors: stats.errors,
      failedCompanies: stats.failedCompanies,
      durationMs: endedAt - startedAt,
    },
  };
}
