import { logger } from "../logger.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { fetchHtml, extractLinkShortlist, extractMainText, extractTitleHint, findOpeningsRecursionLink, type FetchedHtml } from "./cheerio.js";
import type { RenderedPage } from "./playwright.js";
import { runShortlist, type ShortlistItem } from "../llm/shortlist.js";
import { runShortlistFromText } from "../llm/extract-text-jobs.js";
import { getLinkCache, setLinkCache, updateParsingStrategy, markUrlSuspect, type ShortlistedLink } from "../db/index.js";
import { extractAtsCandidates } from "../discovery/ats.js";
import { updateRegistryStrategy } from "../discovery/registry-writer.js";
import { profile } from "../profile.js";
import { extractJsonLdJobs } from "./json-ld.js";
import { analyzeCareersPage } from "./page-signals.js";
import { htmlToText } from "../ats/html-text.js";
import { REMOTE_RE } from "../ats/shared.js";

const LINK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Stable short hash so text-fallback externalIds dedup across ticks.
function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// At/below this many same-host candidate links, the page is almost certainly
// an SPA cheerio can't read — bail rather than waste an LLM call.
const SPA_SENTINEL_THRESHOLD = 3;

export type Fetcher = (url: string) => Promise<FetchedHtml | RenderedPage>;

export interface LlmScrapeFactoryOptions {
  /** Log tag — distinguishes "llm-scrape" from "playwright-llm-scrape". */
  tag: string;
  fetcher: Fetcher;
  /**
   * Apply the SPA sentinel? Default true (raw cheerio). Disabled in the
   * Playwright variant since Playwright IS the SPA fallback.
   */
  spaSentinel?: boolean;
  /**
   * When the page yields zero anchors but the fetcher provided bodyText,
   * try a second-pass LLM extraction from rendered text. Recovers
   * Eightfold/iCIMS SPAs.
   */
  textFallback?: boolean;
}

export function createLlmScrapeAdapter(opts: LlmScrapeFactoryOptions): AtsAdapter {
  const { tag, fetcher } = opts;
  const spaSentinel = opts.spaSentinel ?? true;
  const textFallback = opts.textFallback ?? false;

  return {
    provider: "custom",

    async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
      let page: FetchedHtml | RenderedPage;
      try {
        page = await fetcher(company.careersUrl);
      } catch (err) {
        throw new Error(`${tag} fetch failed for ${company.slug}: ${String(err).slice(0, 160)}`);
      }

      // If the page just links out to a known ATS we have an adapter for,
      // surface a warning and skip — the registry entry should be re-classified.
      const atsHits = extractAtsCandidates(page.html, page.finalUrl);
      const adapterHit = atsHits.find((c) => c.hasAdapter);
      if (adapterHit) {
        logger.warn(
          {
            company: company.slug,
            name: company.name,
            detectedProvider: adapterHit.provider,
            detectedUrl: adapterHit.url,
            detectedSlug: adapterHit.slug,
          },
          `${tag}: detected ATS redirect — re-classify this registry entry`,
        );
        return [];
      }

      // Structured data first: schema.org JobPosting JSON-LD gives titles,
      // locations, and dates without an LLM call — and location metadata
      // lets the cheap pre-gate India filter work for scraped postings.
      const ldJobs = extractJsonLdJobs(page.html);
      if (ldJobs.length > 0) {
        logger.info(
          { company: company.slug, jobs: ldJobs.length },
          `${tag}: using JSON-LD structured data (skipping link shortlist)`,
        );
        return ldJobs.map<NormalizedPosting>((j) => ({
          provider: company.provider,
          externalId: j.url ?? `ld:${company.slug}:${hashKey(j.title + "|" + (j.location ?? ""))}`,
          companySlug: company.slug,
          companyName: company.name,
          jobTitle: j.title,
          jobUrl: j.url ?? page.finalUrl,
          location: j.location,
          isRemote: j.location ? REMOTE_RE.test(j.location) : false,
          jdText: j.description ? htmlToText(j.description) : "",
          postedAt: j.datePosted,
        }));
      }

      let candidates = extractLinkShortlist(page.html, page.finalUrl);

      // One-level recursion when the landing page has 0-ish candidates but
      // contains an obvious "View all jobs"-style CTA.
      if (candidates.length <= SPA_SENTINEL_THRESHOLD) {
        const followUrl = findOpeningsRecursionLink(page.html, page.finalUrl);
        if (followUrl) {
          logger.info(
            { company: company.slug, from: page.finalUrl, to: followUrl },
            `${tag}: recursing into openings link`,
          );
          try {
            const inner = await fetcher(followUrl);
            const innerCands = extractLinkShortlist(inner.html, inner.finalUrl);
            if (innerCands.length > candidates.length) {
              candidates = innerCands;
              page = inner;
            }
          } catch (err) {
            logger.warn(
              { company: company.slug, followUrl, err: String(err).slice(0, 120) },
              `${tag}: recursion fetch failed; continuing with original page`,
            );
          }
        }
      }

      // Zero-yield triage: if we're about to return nothing AND the page
      // doesn't even look like a careers page (or silently redirected to the
      // site root), the URL is the suspect — flag it for the url-repair pass
      // instead of letting the dormancy policy file it under "not hiring".
      const flagIfSuspectUrl = (): void => {
        const sig = analyzeCareersPage(page.html, page.finalUrl, company.careersUrl);
        if (!sig.looksLikeCareersPage || sig.redirectedToRoot) {
          markUrlSuspect(company.provider, company.slug);
          logger.warn(
            { company: company.slug, careersUrl: company.careersUrl, redirectedToRoot: sig.redirectedToRoot },
            `${tag}: zero yield and page does not look like a careers page — flagged url_suspect`,
          );
        }
      };

      if (spaSentinel && candidates.length <= SPA_SENTINEL_THRESHOLD) {
        flagIfSuspectUrl();
        // Act on the recommendation instead of just logging it: flip the
        // strategy in the DB (this run's state) AND the Companies tab (the
        // source of truth — sync would revert a DB-only flip next run).
        // Next run fetches this company through headless chromium.
        updateParsingStrategy(company.provider, company.slug, "playwright-llm-scrape");
        const inRegistry = await updateRegistryStrategy(
          company.provider, company.slug, company.name, "playwright-llm-scrape", profile.id ?? "default",
        ).catch((err: unknown) => {
          logger.warn(
            { company: company.slug, err: String(err).slice(0, 160) },
            `${tag}: Companies-tab strategy flip failed (DB flip already applied) — will retry next zero-yield hit`,
          );
          return false;
        });
        logger.warn(
          { company: company.slug, candidates: candidates.length, careersUrl: company.careersUrl, inRegistry },
          `${tag}: too few candidate links — auto-flipped strategy to playwright-llm-scrape`,
        );
        return [];
      }
      if (!spaSentinel && candidates.length === 0) {
        // Browser-rendered but no anchors — Eightfold/iCIMS often render
        // jobs as non-anchor DOM. Try a text-fallback against bodyText.
        const bodyText = "bodyText" in page ? page.bodyText : undefined;
        if (textFallback && bodyText && bodyText.length > 200) {
          try {
            const textJobs = await runShortlistFromText({ companyName: company.name, bodyText });
            if (textJobs.length > 0) {
              logger.info(
                { company: company.slug, jobs: textJobs.length, careersUrl: company.careersUrl },
                `${tag}: text-fallback extracted ${textJobs.length} jobs from rendered text`
              );
              // No per-job URLs available — synthesize stable externalId so
              // dedup still works, and link clicks fall back to the listing page.
              return textJobs.map<NormalizedPosting>((j) => ({
                provider: company.provider,
                externalId: `text:${company.slug}:${hashKey(j.title + "|" + (j.location ?? ""))}`,
                companySlug: company.slug,
                companyName: company.name,
                jobTitle: j.title,
                jobUrl: page.finalUrl,
                location: j.location ?? null,
                isRemote: j.location ? /\bremote\b/i.test(j.location) : false,
                jdText: "",
                postedAt: null,
              }));
            }
          } catch (err) {
            logger.warn(
              { company: company.slug, err: String(err).slice(0, 160) },
              `${tag}: text-fallback failed`
            );
          }
        }
        flagIfSuspectUrl();
        logger.warn(
          { company: company.slug, careersUrl: company.careersUrl },
          `${tag}: zero candidates even after browser render`
        );
        return [];
      }

      let jobs: ShortlistItem[];
      const cached = getLinkCache(company.provider, company.slug, LINK_CACHE_TTL_MS);
      // An empty cached list is not a usable hit — `[]` is truthy, and serving
      // it would pin the company at zero postings for the whole TTL.
      if (cached && cached.length > 0) {
        jobs = cached;
        logger.debug({ company: company.slug, count: jobs.length }, `${tag}: link cache hit`);
      } else {
        try {
          jobs = await runShortlist({ companyName: company.name, candidates });
        } catch (err) {
          throw new Error(`${tag} shortlist failed for ${company.slug}: ${String(err).slice(0, 160)}`);
        }
        // Only cache a useful result — caching an empty shortlist would skip
        // the LLM retry on every run until the TTL expires.
        if (jobs.length > 0) {
          const toCache: ShortlistedLink[] = jobs.map((j) => ({ url: j.url, title: j.title }));
          setLinkCache(company.provider, company.slug, toCache);
        }
        logger.debug(
          { company: company.slug, candidates: candidates.length, picked: jobs.length },
          `${tag}: shortlist done`,
        );
      }

      if (jobs.length === 0) flagIfSuspectUrl();

      return jobs.map<NormalizedPosting>((j) => ({
        provider: company.provider,
        externalId: j.url,
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: j.title,
        jobUrl: j.url,
        location: null,
        isRemote: false,
        jdText: "",
        postedAt: null,
      }));
    },

    async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
      const { html } = await fetcher(posting.jobUrl);
      // JD pages very often carry a JobPosting JSON-LD block with the full
      // description — cleaner than heuristic main-text stripping.
      const ld = extractJsonLdJobs(html);
      const ldDescription = ld[0]?.description;
      if (ldDescription && ldDescription.length > 100) {
        return htmlToText(ldDescription);
      }
      // Overwrite the listing-shortlist title when it's a generic "Apply Now"-
      // style anchor and the JD page exposes a real <h1>.
      const hint = extractTitleHint(html);
      if (hint && /^(apply now|apply|view (role|job|opening|position)|read more|details|see more|learn more)$/i.test(posting.jobTitle.trim())) {
        posting.jobTitle = hint;
      }
      return extractMainText(html);
    },
  };
}

export const llmScrapeAdapter: AtsAdapter = createLlmScrapeAdapter({
  tag: "llm-scrape",
  fetcher: fetchHtml,
  spaSentinel: true,
});
