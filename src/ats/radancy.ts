// src/ats/radancy.ts — Radancy (formerly TMP Worldwide) enterprise career
// sites, e.g. careers.ford.com (Ford) and jobs.intuit.com (Intuit). Fully
// server-rendered HTML, no auth. The registry `careersUrl` is the listing
// base and may be EITHER a full-board search page (Intuit's
// /search-jobs) or a location-scoped landing (Ford's
// /location/<slug>/<orgId>/<facet>/<page> URLs) — this adapter works with
// either, never hardcoding a path.
//
//   list: GET <careersUrl> for page 1; GET <careersUrl>?p=N (or &p=N if the
//         base already carries a query string) for page N>1. The rendered
//         HTML carries the pager state as plain attributes on a
//         `#search-results`-ish element: `data-total-pages="N"` and
//         `data-total-results="N"`. We also stop defensively on a page that
//         yields zero job links, in case those attributes are ever missing
//         or wrong.
//
//         Job cards live inside whichever element(s) have "search-results"
//         in their id/class (Ford: `#search-results-jobs.search-results-list__list`
//         inside `#search-results`; Intuit: `.search-list` inside
//         `#search-results-list`). This deliberately excludes a same-page
//         "similar jobs" widget Ford renders elsewhere in
//         `.job-list__list` — confirmed live to hold unrelated jobs from
//         other cities, not part of the requested location's results.
//
//         Each card is an anchor with an href containing "/job/" in the
//         shape `/job/<city>/<title-slug>/<orgId>/<jobId>` — the trailing
//         numeric segment is the stable external id. Title is the anchor's
//         own text with any nested `[class*="job-location"]` element's text
//         subtracted (Ford renders location as a sibling outside the
//         anchor, so this is a no-op there; Intuit renders it as a child of
//         the anchor). Location is read from the nearest `[class*="job-location"]`
//         within the anchor's closest `<li>` card.
//
//   jd:   GET the job page. JD body: the first non-empty class tier among
//         `ats-description` (Ford's real body, confirmed live — NOT
//         `content-page-display__description`, which is unrelated marketing
//         boilerplate present on every Ford job page), `job-description`
//         (Intuit's `section.job-description.pane.pane-jd`), then a generic
//         `__description` suffix for any other tenant naming. Within the
//         first matching tier, take the largest block's inner HTML.
//
// Both tenants' WAF/CDN blocks the plain bot UA on at least some routes, so
// every request goes out with a browser UA.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, tenantOrigin } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

// Both live tenants' pager chrome carries data-records-per-page="15"; not
// otherwise parsed/used (pagination relies on data-total-results, not a
// page-length comparison — see listPostings below), so this is informational.
const NOMINAL_PAGE_SIZE = 15;

const TOTAL_PAGES_RE = /data-total-pages="(\d+)"/;
const TOTAL_RESULTS_RE = /data-total-results="(\d+)"/;

// Checked in order; the first tier with any match wins (see file header).
const JD_CLASS_TIERS = ["ats-description", "job-description", "__description"];

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Listing URL for page N (1-based). Page 1 is the bare careersUrl, unmodified. */
export function radancyListUrl(careersUrl: string, page: number): string {
  if (page <= 1) return careersUrl;
  const sep = careersUrl.includes("?") ? "&" : "?";
  return `${careersUrl}${sep}p=${page}`;
}

/** Parse the `data-total-pages` / `data-total-results` pager attributes. Either may be null if absent/malformed. */
export function parseRadancyTotals(html: string): { totalPages: number | null; totalResults: number | null } {
  const pagesMatch = TOTAL_PAGES_RE.exec(html);
  const resultsMatch = TOTAL_RESULTS_RE.exec(html);
  return {
    totalPages: pagesMatch?.[1] ? Number(pagesMatch[1]) : null,
    totalResults: resultsMatch?.[1] ? Number(resultsMatch[1]) : null,
  };
}

/** jobId from a "/job/<city>/<slug>/<orgId>/<jobId>" href — the trailing numeric path segment. Null if absent. */
export function parseRadancyJobId(href: string): string | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  return last && /^\d+$/.test(last) ? last : null;
}

/**
 * Parse the listing page into postings. Scopes card search to elements whose
 * id/class contains "search-results" (both tenants' actual results
 * container), so it never picks up Ford's unrelated same-page "similar
 * jobs" widget (`.job-list__list`). Dedups by externalId — the scoped
 * selector can visit the same anchor twice (nested search-results
 * containers), and this is also a defensive backstop against any future
 * tenant genuinely rendering a duplicate card.
 */
export function parseRadancyList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const base = tenantOrigin(company);
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];
  const seen = new Set<string>();

  $('[id*="search-results"], [class*="search-results"]')
    .find('a[href*="/job/"]')
    .each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      if (!href) return;

      const externalId = parseRadancyJobId(href);
      if (!externalId || seen.has(externalId)) return;

      const $titleClone = $a.clone();
      $titleClone.find('[class*="job-location"], span.location').remove();
      const title = cleanText($titleClone.text());
      if (!title) return;

      let jobUrl: string;
      try {
        jobUrl = new URL(href, base).toString();
      } catch {
        return;
      }

      const $li = $a.closest("li");
      const $card = $li.length ? $li : $a;
      // Some tenants (ARM) use a bare `class="location"` span instead of the
      // usual `job-location` — fall back to it before giving up.
      const $loc = $card.find('[class*="job-location"]').first();
      const $locFallback = $loc.length ? $loc : $card.find("span.location").first();
      const location = cleanText($locFallback.text()) || null;
      const isRemote = location ? REMOTE_RE.test(location) : false;

      seen.add(externalId);
      postings.push({
        provider: "radancy",
        externalId,
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: title,
        jobUrl,
        location,
        isRemote,
        jdText: "",
        postedAt: null,
      });
    });

  return postings;
}

/**
 * Extract the JD body: the first non-empty tier in `JD_CLASS_TIERS`, taking
 * the largest matching block's inner HTML (see file header for why the
 * tiering + "largest" rule matter — Ford's outer `.job-description` wrapper
 * would otherwise out-rank the real `.ats-description` body, and generic
 * `__description` hits would out-rank nothing on tenants that never reach
 * that tier).
 */
export function parseRadancyJd(html: string): string {
  const $ = cheerio.load(html);

  for (const tier of JD_CLASS_TIERS) {
    const candidates = $(`[class*="${tier}"]`)
      .toArray()
      .map((el) => $(el).html() ?? "")
      .filter((inner) => inner.length > 0);
    if (candidates.length === 0) continue;
    const largest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
    return htmlToText(largest);
  }

  return "";
}

export const radancyAdapter: AtsAdapter = {
  provider: "radancy",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "radancy",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      // No page-length comparison in the original loop either - termination
      // is a zero-job page (defensive backstop) or reaching
      // data-total-results, read once from page 1 and never reconsidered
      // (mirrors the original's one-shot data-total-pages read - see below).
      shortPageEndsPagination: false,
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(radancyListUrl(company.careersUrl, page + 1), {
          provider: "radancy",
          userAgent: BROWSER_UA,
        });
        const items = parseRadancyList(html, company);
        // totalResults (data-total-results) is a genuine item count, unlike
        // totalPages (a page count the original loop used instead) - paginate()
        // latches whichever value fetchPage first reports and ignores later
        // ones, exactly matching the original reading this once from page 1
        // and never reconsidering it on later pages.
        const { totalResults } = parseRadancyTotals(html);
        return { items, total: totalResults };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "radancy", userAgent: BROWSER_UA });
    return parseRadancyJd(html);
  },
};
