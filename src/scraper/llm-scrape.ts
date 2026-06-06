import { logger } from "../logger.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { fetchHtml, extractLinkShortlist, extractMainText, extractTitleHint, findOpeningsRecursionLink, type FetchedHtml } from "./cheerio.js";
import type { RenderedPage } from "./playwright.js";
import { runShortlist, type ShortlistItem } from "../llm/shortlist.js";
import { runShortlistFromText } from "../llm/extract-text-jobs.js";
import { getLinkCache, setLinkCache, type ShortlistedLink } from "../db/index.js";
import { extractAtsCandidates } from "../discovery/ats.js";

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
      let page;
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

      if (spaSentinel && candidates.length <= SPA_SENTINEL_THRESHOLD) {
        logger.warn(
          { company: company.slug, candidates: candidates.length, careersUrl: company.careersUrl },
          `${tag}: too few candidate links — set strategy to playwright-llm-scrape`,
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
        logger.warn(
          { company: company.slug, careersUrl: company.careersUrl },
          `${tag}: zero candidates even after browser render`
        );
        return [];
      }

      let jobs: ShortlistItem[];
      const cached = getLinkCache(company.provider, company.slug, LINK_CACHE_TTL_MS);
      if (cached) {
        jobs = cached;
        logger.debug({ company: company.slug, count: jobs.length }, `${tag}: link cache hit`);
      } else {
        try {
          jobs = await runShortlist({ companyName: company.name, candidates });
        } catch (err) {
          throw new Error(`${tag} shortlist failed for ${company.slug}: ${String(err).slice(0, 160)}`);
        }
        const toCache: ShortlistedLink[] = jobs.map((j) => ({ url: j.url, title: j.title }));
        setLinkCache(company.provider, company.slug, toCache);
        logger.debug(
          { company: company.slug, candidates: candidates.length, picked: jobs.length },
          `${tag}: shortlist done`,
        );
      }

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
