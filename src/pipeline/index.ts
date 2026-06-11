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
import { notifySummary } from "../discord/notify.js";
import { resolveAdapter } from "../ats/registry.js";
import { processBucket } from "./scheduler.js";

export interface RunContext {
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

  const stats: RunContext = {
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

  const parked = applyDormancy();
  if (parked > 0) {
    logger.info({ companies: parked }, "dormancy: zero-yield scrape companies parked (weekly recheck)");
  }

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
