import { logger } from "../logger.js";
import type { AtsAdapter } from "../ats/types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { fetchHtml, extractLinkShortlist, extractMainText, extractTitleHint, findOpeningsRecursionLink } from "./cheerio.js";
import type { FetchedHtml } from "./cheerio.js";
import type { RenderedPage } from "./playwright.js";
import { runShortlist } from "../llm/shortlist.js";
import type { ShortlistItem } from "../llm/shortlist.js";
import { runShortlistFromText } from "../llm/extractTextJobs.js";
import { getLinkCache, setLinkCache, updateParsingStrategy, markUrlSuspect } from "../db/index.js";
import type { ShortlistedLink } from "../db/index.js";
import { extractAtsCandidates } from "../ats/detect.js";
import { updateRegistryStrategy } from "../registry/sheetWriter.js";
import { profile } from "../profile.js";
import { extractJsonLdJobs } from "./jsonLd.js";
import { analyzeCareersPage } from "./pageSignals.js";
import { htmlToText } from "../ats/htmlText.js";
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

// At/below this many same-host candidate links, the page is almost certainly an SPA cheerio can't read.
const SPA_SENTINEL_THRESHOLD = 3;

/** The company slug of a YC company-profile URL, or null for anything else. */
function ycCompanySlug(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)ycombinator\.com$/i.test(u.hostname)) return null;
    return /^\/companies\/([^/]+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** YC company pages embed "similar jobs" links to OTHER YC companies; drops links pointing at a different company's YC page. No-op for non-YC pages. */
export function dropCrossCompanyYcLinks<T extends { url: string }>(items: T[], careersUrl: string): T[] {
  const own = ycCompanySlug(careersUrl);
  if (!own) return items;
  return items.filter((item) => {
    const slug = ycCompanySlug(item.url);
    return slug === null || slug === own;
  });
}

export type Fetcher = (url: string) => Promise<FetchedHtml | RenderedPage>;

export interface LlmScrapeFactoryOptions {
  /** Log tag — distinguishes "llm-scrape" from "playwright-llm-scrape". */
  tag: string;
  fetcher: Fetcher;
  /** Apply the SPA sentinel? Default true; disabled in the Playwright variant since Playwright IS the SPA fallback. */
  spaSentinel?: boolean;
  /** Second-pass LLM extraction from rendered bodyText when there are zero anchors; recovers Eightfold/iCIMS SPAs. */
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

      // If the page just links out to a known ATS we have an adapter for, warn and skip - re-classify the registry entry.
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

      // Structured data first: JSON-LD gives titles/locations/dates without an LLM call, and location metadata feeds the pre-gate India filter.
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

      // One-level recursion when the landing page has 0-ish candidates but an obvious "View all jobs"-style CTA.
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

      // Guard runs BEFORE the sentinel/shortlist so cross-company YC links can't inflate the candidate count or reach the LLM.
      candidates = dropCrossCompanyYcLinks(candidates, company.careersUrl);

      // If we're about to return nothing and the page doesn't look like a careers page, flag url_suspect instead of "not hiring".
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
        // Flip strategy in both the DB (this run) and the Companies tab (source of truth, or a sync would revert it).
        updateParsingStrategy(company.provider, company.slug, "playwright-llm-scrape");
        const inRegistry = await updateRegistryStrategy(
          company.provider, company.slug, company.name, "playwright-llm-scrape", profile.id ?? "default",
        // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
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
        // Browser-rendered but no anchors - Eightfold/iCIMS often render jobs as non-anchor DOM.
        const bodyText = "bodyText" in page ? page.bodyText : undefined;
        if (textFallback && bodyText && bodyText.length > 200) {
          try {
            const textJobs = await runShortlistFromText({ companyName: company.name, bodyText });
            if (textJobs.length > 0) {
              logger.info(
                { company: company.slug, jobs: textJobs.length, careersUrl: company.careersUrl },
                `${tag}: text-fallback extracted ${textJobs.length} jobs from rendered text`
              );
              // No per-job URLs available - synthesize a stable externalId; link clicks fall back to the listing page.
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
      // An empty cached list is not a usable hit - serving it would pin the company at zero postings for the whole TTL.
      if (cached && cached.length > 0) {
        // Re-filter: rows cached before the guard existed may still carry cross-company YC links.
        jobs = dropCrossCompanyYcLinks(cached, company.careersUrl);
        logger.debug({ company: company.slug, count: jobs.length }, `${tag}: link cache hit`);
      } else {
        try {
          jobs = await runShortlist({ companyName: company.name, candidates });
        } catch (err) {
          throw new Error(`${tag} shortlist failed for ${company.slug}: ${String(err).slice(0, 160)}`);
        }
        // Only cache a useful result - an empty shortlist would skip the LLM retry until the TTL expires.
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
      // JD pages often carry a JobPosting JSON-LD block, cleaner than heuristic main-text stripping.
      const ld = extractJsonLdJobs(html);
      const ldDescription = ld[0]?.description;
      if (ldDescription && ldDescription.length > 100) {
        return htmlToText(ldDescription);
      }
      // Overwrite a generic "Apply Now"-style shortlist title when the JD page exposes a real <h1>.
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
