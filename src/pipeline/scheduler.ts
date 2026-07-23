import { logger } from "../logger.js";
import { config } from "../config.js";
import {
  markFetchSuccess,
  markFetchFailure,
} from "../db/index.js";
import type { AtsAdapter } from "../ats/types.js";
import type { Company, NormalizedPosting } from "../types.js";
import { isDeniedCompany } from "../filter/denylist.js";
import { OllamaUnavailableError } from "../llm/client.js";
import { toAdapterCompany } from "./index.js";
import type { RunContext } from "./index.js";
import { processOnePosting } from "./posting-pipeline.js";

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

export async function processBucket(
  bucketKey: string,
  adapter: AtsAdapter,
  companies: Company[],
  stats: RunContext,
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
      await processOneCompany(adapter, company, stats);
      // Count every company worked (fetched or denylist-skipped) so the bucket's
      // scanned reaches its total — this drives the progress heartbeat.
      if (progress) progress.scanned++;
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
  stats: RunContext,
): Promise<void> {
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
    // Backend down (scrape adapters call the LLM shortlist) — abort, don't
    // mark every company a fetch failure against a dead Ollama.
    if (err instanceof OllamaUnavailableError) throw err;
    const msg = String(err);
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
        await processOnePosting(adapter, adapterCompany, posting, company, stats);
      } catch (err) {
        // Propagate a backend-down abort; only swallow per-posting errors.
        if (err instanceof OllamaUnavailableError) throw err;
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
