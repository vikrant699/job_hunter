import { logger } from "../logger.js";
import { config } from "../config.js";
import {
  markFetchSuccess,
  markFetchFailure,
  markTransportFailure,
} from "../db/index.js";
import { describeError, isInfrastructureFault } from "../util/errorCause.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, Company, NormalizedPosting } from "../types.js";
import { isDeniedCompany } from "../filter/denylist.js";
import { OllamaUnavailableError } from "../llm/client.js";
import { toAdapterCompany } from "./index.js";
import type { DeferredBoard, RunContext } from "./index.js";
import { processOnePosting } from "./postingPipeline.js";
import { sleep } from "../util/sleep.js";

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

/** Timing for infrastructure faults: the inline backoff schedule plus the pace of
 *  the end-of-run deferred pass. Injected so tests need not wait real seconds;
 *  production always passes the config values via defaultRetryPolicy(). */
export interface TransportRetryPolicy {
  retries: number;
  baseDelayMs: number;
  /** Pause BETWEEN deferred boards, which the deferred pass works one at a time.
   *  See config.fetch.deferredPassPaceMs for where the number comes from. */
  deferredPaceMs: number;
}

export function defaultRetryPolicy(): TransportRetryPolicy {
  return {
    retries: config.fetch.transportRetries,
    baseDelayMs: config.fetch.transportRetryBaseMs,
    deferredPaceMs: config.fetch.deferredPassPaceMs,
  };
}

export async function processBucket(
  bucketKey: string,
  adapter: AtsAdapter,
  companies: Company[],
  stats: RunContext,
  retry: TransportRetryPolicy = defaultRetryPolicy(),
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
      await processOneCompany(adapter, company, stats, retry);
      // Count every company worked (fetched or denylist-skipped) so the bucket's
      // scanned reaches its total — this drives the progress heartbeat.
      if (progress) progress.scanned++;
      if (config.fetch.interCallDelayMs > 0) {
        await sleep(config.fetch.interCallDelayMs);
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
}

/**
 * Deferred boards in round-robin order across their providers. These boards are
 * here because a vendor's edge (or the network) refused a burst, so draining one
 * vendor's queue back-to-back would aim the same concentrated rate at it again;
 * alternating vendors spreads each one's requests over the whole pass for free.
 */
function interleaveByProvider(deferred: DeferredBoard[]): DeferredBoard[] {
  const queues = new Map<string, DeferredBoard[]>();
  for (const d of deferred) {
    const q = queues.get(d.company.provider);
    if (q) q.push(d);
    else queues.set(d.company.provider, [d]);
  }
  const out: DeferredBoard[] = [];
  // Each sweep takes one board from every provider that still has one, so every
  // sweep makes progress and this terminates.
  while (out.length < deferred.length) {
    for (const q of queues.values()) {
      const next = q.shift();
      if (next !== undefined) out.push(next);
    }
  }
  return out;
}

/**
 * Second chance for boards the infrastructure took down. Inline retries
 * (listWithTransportRetry) span ~35s, which covers a blip but not a multi-minute
 * outage: in run 29 a ~9-minute network failure at 22:42 killed 72 Workday boards,
 * and the network was healthy again by 22:49. An edge throttle behaves the same way
 * — run 31 lost 17 alphabetically-adjacent Workday tenants to a 24-second burst,
 * and by then the bucket had moved on to a different vendor. By the time every
 * bucket has finished, such a fault has had the rest of the run to clear, so one
 * more attempt recovers boards that would otherwise have been written off.
 *
 * Paced, NOT parallel: one board at a time with a gap between them. Replaying a
 * throttled group at concurrencyPerProvider is the very burst that deferred them,
 * which is how run 31 could keep all 17 boards out of quarantine and still lose
 * their 909 postings. Getting the jobs is the goal; protecting the row is not.
 * Sequential is affordable precisely because this pass is small (8 boards in run
 * 31) and runs when nothing else is left to do.
 *
 * A board that fails this way on BOTH passes is finally recorded as a real failure
 * — at that point "it wasn't the board" is no longer a credible excuse.
 */
export async function runDeferredTransportPass(
  stats: RunContext,
  retry: TransportRetryPolicy = defaultRetryPolicy(),
): Promise<void> {
  const deferred = stats.transportDeferred;
  if (deferred.length === 0) return;
  // Clear before re-running: processOneCompany pushes onto this same array, and
  // what lands there during the pass is the still-failing set.
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

/**
 * Fetch a board's listing, retrying infrastructure failures in place. A brief
 * DNS/socket outage must not be mistaken for a broken board (run 29 lost 72
 * healthy Workday boards in 21 seconds that way), nor must an edge throttling a
 * burst of sibling tenants (run 31 lost 17 the same way in 24 seconds), so each
 * such error backs off and retries. The delays also slow the worker down, which is
 * the point: a bucket that keeps its queue through a blip — or through an edge's
 * cool-off — gets to fetch those boards after recovery instead of burning them.
 *
 * Board-shaped failures (HTTP status, schema, config) are NOT retried — the
 * board answered, so a second identical request just wastes a round trip.
 */
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
      if (err instanceof OllamaUnavailableError) throw err;
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

  let postings: NormalizedPosting[];
  try {
    postings = await listWithTransportRetry(adapter, adapterCompany, company, stats, retry);
  } catch (err) {
    // Backend down (scrape adapters call the LLM shortlist) — abort, don't
    // mark every company a fetch failure against a dead Ollama.
    if (err instanceof OllamaUnavailableError) throw err;
    const msg = describeError(err);

    // Infrastructure failed even after retries — the transport died, or an edge
    // answered on the board's behalf. Either way the board's application never
    // spoke, so it told us nothing about its own health: record the diagnostics but
    // leave the quarantine counter alone, and hand it to the end-of-run deferred pass.
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
    // A board that errored was NOT scanned — record it as an issue instead of
    // counting it toward companiesScanned (which now means "fetched OK").
    stats.failedCompanies.push({
      provider: company.provider,
      slug: company.slug,
      reason: classifyFetchError(msg),
    });
    return;
  }

  // Only a successful fetch counts as scanned — errored/skipped boards don't.
  stats.companiesScanned++;
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
        await processOnePosting(adapter, adapterCompany, posting, company, stats, retry);
      } catch (err) {
        // Propagate a backend-down abort; only swallow per-posting errors.
        if (err instanceof OllamaUnavailableError) throw err;
        logger.error(
          { company: company.name, externalId: posting.externalId, err: describeError(err) },
          "posting pipeline error",
        );
        stats.errors.push(`${company.slug}#${posting.externalId}: ${describeError(err).slice(0, 100)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => postingWorker()));
}
