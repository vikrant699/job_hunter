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

/** Collapse a raw fetch error into a short tag for the Discord issue list. */
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

/** Writes a board_runs 'error' row wherever a fetch is recorded as a genuine board failure (markFetchFailure's
 *  two call sites) — a transient defer that hasn't yet given up gets no row of its own. */
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

/** Timing for infrastructure faults (inline backoff + deferred-pass pace); injected so tests skip real waits. */
export interface TransportRetryPolicy {
  retries: number;
  baseDelayMs: number;
  /** Pause between deferred boards, which the deferred pass works one at a time. */
  deferredPaceMs: number;
}

export function defaultRetryPolicy(): TransportRetryPolicy {
  return {
    retries: config.fetch.transportRetries,
    baseDelayMs: config.fetch.transportRetryBaseMs,
    deferredPaceMs: config.fetch.deferredPassPaceMs,
  };
}

/** Per-provider start throttle, live across a whole processBucket call (or several, if injected in): caps how many of
 *  that provider's boards fetch concurrently and spaces successive starts apart. Un-throttled providers pass through
 *  with no wait at all - same code path as before this existed. */
export interface ProviderThrottleState {
  /** Waits out this provider's throttle (if it has one), then returns the release to call once the fetch is done. */
  start(provider: string): Promise<() => void>;
}

interface ThrottleEntry {
  /** Bounds concurrent in-flight fetches for this provider to maxConcurrent. */
  acquireSlot: () => Promise<() => void>;
  /** Mutex serializing the "wait out the spacing, then stamp lastStartAt" step, so two starts racing on the same
   *  provider can't both read a stale lastStartAt and land within minSpacingMs of each other. Held only for that
   *  brief step, never for the fetch itself, so it can't stall other providers or even other in-flight fetches of
   *  its own provider. */
  claimStart: () => Promise<() => void>;
  minSpacingMs: number;
  lastStartAt: number;
}

/** Builds a fresh throttle registry; `table` defaults to config's but is injectable so tests can use a tiny minSpacingMs. */
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
      // Count every company worked (fetched or skipped) so scanned reaches total, driving the progress heartbeat.
      if (progress) progress.scanned++;
      if (config.fetch.interCallDelayMs > 0) {
        await sleep(config.fetch.interCallDelayMs);
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
}

/** Round-robins deferred boards across providers, so draining one vendor's queue back-to-back doesn't re-aim the same burst that got it deferred. */
function interleaveByProvider(deferred: DeferredBoard[]): DeferredBoard[] {
  const queues = new Map<string, DeferredBoard[]>();
  for (const d of deferred) {
    const q = queues.get(d.company.provider);
    if (q) q.push(d);
    else queues.set(d.company.provider, [d]);
  }
  const out: DeferredBoard[] = [];
  // Each sweep takes one board per remaining provider queue, so it always makes progress and terminates.
  while (out.length < deferred.length) {
    for (const q of queues.values()) {
      const next = q.shift();
      if (next !== undefined) out.push(next);
    }
  }
  return out;
}

/** Second chance for boards infrastructure took down: inline retries cover only a brief blip, not a multi-minute outage or an
 *  edge throttle, so this replays them once more after every bucket is done, sequentially and spaced (replaying at full
 *  concurrency would recreate the burst that got them deferred). Failing both passes is finally recorded as a real failure. */
export async function runDeferredTransportPass(
  stats: RunContext,
  retry: TransportRetryPolicy = defaultRetryPolicy(),
): Promise<void> {
  const deferred = stats.transportDeferred;
  if (deferred.length === 0) return;
  // Clear before re-running: processOneCompany pushes onto this same array, so what lands there is the still-failing set.
  stats.transportDeferred = [];

  logger.info(
    { boards: deferred.length, paceMs: retry.deferredPaceMs },
    "deferred transport pass: retrying boards the network or an edge refused mid-run, one at a time",
  );

  const scannedBefore = stats.companiesScanned;
  for (const [i, d] of interleaveByProvider(deferred).entries()) {
    // No gap before the first board: the last request to any of these vendors was
    // a whole run ago, so only the gaps between boards buy anything.
    if (i > 0 && retry.deferredPaceMs > 0) await sleep(retry.deferredPaceMs);
    await processOneCompany(d.adapter, d.company, stats, retry);
  }
  // Only deferred boards ran in this pass, so the delta is what recovered.
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

/** Fetches a board's listing, retrying infrastructure failures (DNS/socket, edge throttle) in place with backoff, so a
 *  transient outage isn't mistaken for a broken board. Board-shaped failures (HTTP status, schema, config) are not retried. */
export async function listWithTransportRetry(
  adapter: AtsAdapter,
  adapterCompany: AdapterCompany,
  company: Company,
  stats: RunContext,
  retry: TransportRetryPolicy,
): Promise<NormalizedPosting[]> {
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  let lastErr: unknown;
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
  // Bounds markRemoved below: any row this company already had, whose last_seen_at predates this moment,
  // wasn't in THIS fetch's listing. Captured before the fetch so it can't clip a posting this same fetch inserts.
  const fetchStartedAt = new Date().toISOString();

  let postings: NormalizedPosting[];
  try {
    postings = await listWithTransportRetry(adapter, adapterCompany, company, stats, retry);
  } catch (err) {
    // Backend down (scrape adapters call the LLM shortlist) - abort rather than mark every company a fetch failure against a dead Ollama.
    if (err instanceof LlmUnavailableError) throw err;
    const msg = describeError(err);

    // The board's application never spoke (transport died, or an edge answered on its behalf), so it told us nothing about its
    // own health: leave the quarantine counter alone and hand it to the end-of-run deferred pass.
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
    // Errored boards are not scanned; record as an issue instead of counting toward companiesScanned.
    stats.failedCompanies.push({
      provider: company.provider,
      slug: company.slug,
      reason: classifyFetchError(msg),
    });
    // A failed listing fetch never touches lifecycle columns — we don't know what the board currently has.
    recordBoardRunFailure(company.provider, company.slug, stats.profileId, fetchStartedAt, msg);
    return;
  }

  // Only a successful fetch counts as scanned — errored/skipped boards don't.
  stats.companiesScanned++;
  markFetchSuccess(company.provider, company.slug, postings.length);

  // A listed posting is "seen" regardless of relevance, so this covers the FULL listing, including
  // postings the filters below will drop — bump last_seen_at (and revive, clearing removed_at) for all of them.
  const seenAt = new Date().toISOString();
  markSeen(
    company.provider,
    company.slug,
    stats.profileId,
    postings.map((p) => p.externalId),
    seenAt,
  );

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
        await processOnePosting(adapter, adapterCompany, posting, company, stats, retry);
      } catch (err) {
        // Propagate a backend-down abort; only swallow per-posting errors.
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

  // Anything of this board's not bumped by markSeen above (last_seen_at still predates this fetch) disappeared.
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
