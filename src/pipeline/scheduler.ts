import { logger } from "../logger.js";
import { config, throttleFor } from "../config.js";
import type { ProviderThrottle } from "../config.js";
import {
  markFetchSuccess,
  markFetchFailure,
  markTransportFailure,
  markSeen,
  markRemoved,
  countInsertedSince,
  insertBoardRun,
} from "../db/index.js";
import { describeError, isInfrastructureFault } from "../util/errorCause.js";
import type { Caught } from "../util/errorCause.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, Company, NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";
import { isDeniedCompany } from "../filter/denylist.js";
import { LlmUnavailableError } from "../llm/errors.js";
import { toAdapterCompany } from "./index.js";
import type { DeferredBoard, RunContext } from "./index.js";
import { processOnePosting } from "./postingPipeline.js";
import { sleep } from "../util/sleep.js";
import { makeSemaphore } from "../util/semaphore.js";
import { aggregatorWarning } from "../util/aggregatorGuard.js";

export function classifyFetchError(msg: string): string {
  if (/AbortError|aborted|timeout|timed out|ETIMEDOUT/i.test(msg)) return "timeout";
  if (/\b404\b|not found/i.test(msg)) return "404";
  if (/\b(429)\b|rate.?limit|limit exceeded/i.test(msg)) return "rate-limited";
  if (/\b5\d\d\b|HTTP 5/i.test(msg)) return "5xx";
  if (/schema/i.test(msg)) return "schema";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|cert/i.test(msg)) return "network";
  if (/requires tenant_url|missing .* segment|missing tenant/i.test(msg)) return "config";
  return "other";
}

function recordBoardRunFailure(
  provider: Provider,
  slug: string,
  profileId: string,
  runAt: string,
  err: string,
): void {
  insertBoardRun({
    provider,
    companySlug: slug,
    profileId,
    runAt,
    status: "error",
    added: 0,
    removed: 0,
    unchanged: 0,
    error: err.slice(0, 300),
  });
}

export interface TransportRetryPolicy {
  retries: number;
  baseDelayMs: number;
  deferredPaceMs: number;
}

export function defaultRetryPolicy(): TransportRetryPolicy {
  return {
    retries: config.fetch.transportRetries,
    baseDelayMs: config.fetch.transportRetryBaseMs,
    deferredPaceMs: config.fetch.deferredPassPaceMs,
  };
}

export interface ProviderThrottleState {
  start(provider: string): Promise<() => void>;
}

interface ThrottleEntry {
  acquireSlot: () => Promise<() => void>;
  claimStart: () => Promise<() => void>;
  minSpacingMs: number;
  lastStartAt: number;
}

export function createProviderThrottleState(
  table: Partial<Record<string, ProviderThrottle>> = config.fetch.providerThrottle,
): ProviderThrottleState {
  const entries = new Map<string, ThrottleEntry>();
  function entryFor(provider: string, cfg: ProviderThrottle): ThrottleEntry {
    const existing = entries.get(provider);
    if (existing) return existing;
    const created: ThrottleEntry = {
      acquireSlot: makeSemaphore(() => cfg.maxConcurrent),
      claimStart: makeSemaphore(() => 1),
      minSpacingMs: cfg.minSpacingMs,
      lastStartAt: 0,
    };
    entries.set(provider, created);
    return created;
  }
  return {
    async start(provider: string): Promise<() => void> {
      const cfg = throttleFor(provider, table);
      if (!cfg) return () => {};
      const entry = entryFor(provider, cfg);
      const releaseSlot = await entry.acquireSlot();
      const releaseClaim = await entry.claimStart();
      const wait = entry.lastStartAt + entry.minSpacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      entry.lastStartAt = Date.now();
      releaseClaim();
      return releaseSlot;
    },
  };
}

export async function processBucket(
  bucketKey: string,
  adapter: AtsAdapter,
  companies: Company[],
  stats: RunContext,
  retry: TransportRetryPolicy = defaultRetryPolicy(),
  throttle: ProviderThrottleState = createProviderThrottleState(),
): Promise<void> {
  if (companies.length === 0) return;
  logger.debug({ bucket: bucketKey, count: companies.length }, "processing bucket");

  const cap = config.fetch.concurrencyPerProvider;
  let cursor = 0;

  const progress = stats.bucketProgress.get(bucketKey);

  async function worker(): Promise<void> {
    while (cursor < companies.length) {
      const idx = cursor++;
      const company = companies[idx];
      if (!company) return;
      const releaseThrottle = await throttle.start(company.provider);
      try {
        await processOneCompany(adapter, company, stats, retry);
      } finally {
        releaseThrottle();
      }
      if (progress) progress.scanned++;
      if (config.fetch.interCallDelayMs > 0) {
        await sleep(config.fetch.interCallDelayMs);
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
}

function interleaveByProvider(deferred: DeferredBoard[]): DeferredBoard[] {
  const queues = new Map<string, DeferredBoard[]>();
  for (const d of deferred) {
    const q = queues.get(d.company.provider);
    if (q) q.push(d);
    else queues.set(d.company.provider, [d]);
  }
  const out: DeferredBoard[] = [];
  while (out.length < deferred.length) {
    for (const q of queues.values()) {
      const next = q.shift();
      if (next !== undefined) out.push(next);
    }
  }
  return out;
}

export async function runDeferredTransportPass(
  stats: RunContext,
  retry: TransportRetryPolicy = defaultRetryPolicy(),
): Promise<void> {
  const deferred = stats.transportDeferred;
  if (deferred.length === 0) return;
  // processOneCompany pushes onto this same array, so clearing leaves only the still-failing set.
  stats.transportDeferred = [];

  logger.info(
    { boards: deferred.length, paceMs: retry.deferredPaceMs },
    "deferred transport pass: retrying boards the network or an edge refused mid-run, one at a time",
  );

  const scannedBefore = stats.companiesScanned;
  for (const [i, d] of interleaveByProvider(deferred).entries()) {
    if (i > 0 && retry.deferredPaceMs > 0) await sleep(retry.deferredPaceMs);
    await processOneCompany(d.adapter, d.company, stats, retry);
  }
  stats.transportRecovered = stats.companiesScanned - scannedBefore;

  const stillFailing = stats.transportDeferred;
  stats.transportDeferred = [];
  for (const d of stillFailing) {
    const msg = `network or edge refused the board on both passes: ${d.err}`;
    markFetchFailure(d.company.provider, d.company.slug, msg);
    stats.errors.push(`${d.company.provider}/${d.company.slug}: ${msg.slice(0, 100)}`);
    stats.failedCompanies.push({
      provider: d.company.provider,
      slug: d.company.slug,
      reason: classifyFetchError(d.err),
    });
    recordBoardRunFailure(d.company.provider, d.company.slug, stats.profileId, new Date().toISOString(), msg);
  }

  logger.info(
    {
      attempted: deferred.length,
      recovered: stats.transportRecovered,
      stillFailing: stillFailing.length,
    },
    "deferred transport pass complete",
  );
}

export async function listWithTransportRetry(
  adapter: AtsAdapter,
  adapterCompany: AdapterCompany,
  company: Company,
  stats: RunContext,
  retry: TransportRetryPolicy,
): Promise<NormalizedPosting[]> {
  let lastErr: Caught;
  for (let attempt = 0; attempt <= retry.retries; attempt++) {
    try {
      return await adapter.listPostings(adapterCompany);
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      if (!isInfrastructureFault(err)) throw err;
      lastErr = err;
      if (attempt < retry.retries) {
        const delay = retry.baseDelayMs * 2 ** attempt;
        stats.transportRetried++;
        logger.warn(
          { company: company.name, slug: company.slug, attempt, delayMs: delay, err: describeError(err) },
          "network or edge refused the board — backing off and retrying",
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

async function processOneCompany(
  adapter: AtsAdapter,
  company: Company,
  stats: RunContext,
  retry: TransportRetryPolicy,
): Promise<void> {
  const deny = isDeniedCompany(company.name, company.slug);
  if (deny.denied) {
    logger.debug({ company: company.name, reason: deny.reason }, "skip: services-denylist");
    return;
  }

  const adapterCompany = toAdapterCompany(company);
  // Captured before the fetch so markRemoved can't clip a posting this fetch inserts.
  const fetchStartedAt = new Date().toISOString();

  let postings: NormalizedPosting[];
  try {
    postings = await listWithTransportRetry(adapter, adapterCompany, company, stats, retry);
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    const msg = describeError(err);

    if (isInfrastructureFault(err)) {
      logger.warn(
        { company: company.name, slug: company.slug, err: msg },
        "network or edge refused the board after retries — deferred to end-of-run pass, not counted against the board",
      );
      markTransportFailure(company.provider, company.slug, msg);
      stats.transportDeferred.push({ company, adapter, err: msg });
      return;
    }

    logger.warn({ company: company.name, slug: company.slug, err: msg }, "fetch failed");
    markFetchFailure(company.provider, company.slug, msg);
    stats.errors.push(`${company.provider}/${company.slug}: ${msg.slice(0, 100)}`);
    stats.failedCompanies.push({
      provider: company.provider,
      slug: company.slug,
      reason: classifyFetchError(msg),
    });
    recordBoardRunFailure(company.provider, company.slug, stats.profileId, fetchStartedAt, msg);
    return;
  }

  stats.companiesScanned++;
  markFetchSuccess(company.provider, company.slug, postings.length);

  const aggWarning = aggregatorWarning(company.provider, company.slug, postings);
  if (aggWarning) logger.warn(aggWarning, "board looks like an aggregator");

  const seenAt = new Date().toISOString();
  markSeen(
    company.provider,
    company.slug,
    stats.profileId,
    postings.map((p) => p.externalId),
    seenAt,
  );

  const workers = config.fetch.workersPerCompany;
  let cursor = 0;
  async function postingWorker(): Promise<void> {
    while (cursor < postings.length) {
      const idx = cursor++;
      const posting = postings[idx];
      if (!posting) return;
      stats.postingsSeen++;
      try {
        await processOnePosting(adapter, adapterCompany, posting, company, stats, retry);
      } catch (err) {
        if (err instanceof LlmUnavailableError) throw err;
        logger.error(
          { company: company.name, externalId: posting.externalId, err: describeError(err) },
          "posting pipeline error",
        );
        stats.errors.push(`${company.slug}#${posting.externalId}: ${describeError(err).slice(0, 100)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => postingWorker()));

  const removed = markRemoved(company.provider, company.slug, stats.profileId, fetchStartedAt, new Date().toISOString());
  const added = countInsertedSince(company.provider, company.slug, stats.profileId, fetchStartedAt);
  insertBoardRun({
    provider: company.provider,
    companySlug: company.slug,
    profileId: stats.profileId,
    runAt: fetchStartedAt,
    status: "ok",
    added,
    removed,
    unchanged: postings.length - added,
    error: null,
  });
}
