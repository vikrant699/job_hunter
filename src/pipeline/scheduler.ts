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
  stats: RunContext,
): Promise<void> {
  const deny = isDeniedCompany(company.name, company.slug);
  if (deny.denied) {
    logger.debug({ company: company.name, reason: deny.reason }, "skip: services-denylist");
    return;
  }
  stats.companiesScanned++;

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
