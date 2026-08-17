// src/ats/radancy.ts — Radancy enterprise career sites (e.g. careers.ford.com, jobs.intuit.com).
// Fully server-rendered HTML, no auth. careersUrl may be a full-board search page or a
// location-scoped landing; pagination is `?p=N` and pager state comes from data-total-pages/
// data-total-results attributes on the results container. Job cards live inside whichever element
// has "search-results" in its id/class (excludes Ford's unrelated same-page "similar jobs" widget);
// externalId is the trailing numeric segment of the card's `/job/.../<jobId>` href. JD body is the
// largest block in the first matching class tier of ats-description/job-description/__description.
// Both tenants' WAF/CDN blocks the plain bot UA on some routes, so every request uses a browser UA.
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, tenantOrigin, collapseWs } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

const NOMINAL_PAGE_SIZE = 15; // informational only; pagination relies on data-total-results, not this

const TOTAL_PAGES_RE = /data-total-pages="(\d+)"/;
const TOTAL_RESULTS_RE = /data-total-results="(\d+)"/;

// "No job cards" alone can't signal a dead board: a live search page can legitimately match zero
// India results (data-total-results="0"), which looks identical to the domain having quietly
// stopped serving Radancy altogether. data-total-results is emitted on the results section whatever
// the count, so its total absence (not zero count) is what means the board is gone. A WAF challenge
// page also lacks that attribute, so it's checked for a block signature first and treated as
// infrastructure (retried/deferred) rather than charged to the row.
export function assertRadancyBoardServed(
  totalResults: number | null,
  careersUrl: string,
  html: string,
): void {
  if (totalResults !== null) return;
  assertNotEdgeChallenge("radancy", careersUrl, html);

  throw new Error(
    `radancy: board no longer served — ${careersUrl} returned a page with no job cards AND no ` +
      `data-total-results pager state, so it is not a Radancy search-results page and the board ` +
      `is dead rather than empty.`,
  );
}

// Checked in order; the first tier with any match wins (see file header).
const JD_CLASS_TIERS = ["ats-description", "job-description", "__description"];

// Page 1 is the bare careersUrl, unmodified.
export function radancyListUrl(careersUrl: string, page: number): string {
  if (page <= 1) return careersUrl;
  const sep = careersUrl.includes("?") ? "&" : "?";
  return `${careersUrl}${sep}p=${page}`;
}

export function parseRadancyTotals(html: string): { totalPages: number | null; totalResults: number | null } {
  const pagesMatch = TOTAL_PAGES_RE.exec(html);
  const resultsMatch = TOTAL_RESULTS_RE.exec(html);
  return {
    totalPages: pagesMatch?.[1] ? Number(pagesMatch[1]) : null,
    totalResults: resultsMatch?.[1] ? Number(resultsMatch[1]) : null,
  };
}

// jobId is the trailing numeric segment of a "/job/<city>/<slug>/<orgId>/<jobId>" href.
export function parseRadancyJobId(href: string): string | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  return last && /^\d+$/.test(last) ? last : null;
}

// Scopes card search to elements whose id/class contains "search-results" so it never picks up
// Ford's unrelated same-page "similar jobs" widget. Dedups by externalId (nested search-results
// containers can visit the same anchor twice).
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
      const title = collapseWs($titleClone.text());
      if (!title) return;

      let jobUrl: string;
      try {
        jobUrl = new URL(href, base).toString();
      } catch {
        return;
      }

      const $li = $a.closest("li");
      // Table-layout tenants put the location span in a sibling <td>, outside the anchor entirely.
      const $tr = $li.length ? $li : $a.closest("tr");
      const $card = $tr.length ? $tr : $a;
      // Some tenants use a bare `class="location"` span instead of `job-location`.
      const $loc = $card.find('[class*="job-location"]').first();
      const $locFallback = $loc.length ? $loc : $card.find("span.location").first();
      const location = collapseWs($locFallback.text()) || null;
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

// The largest matching block in the first non-empty tier — Ford's outer .job-description wrapper
// would otherwise out-rank the real .ats-description body.
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
    const state: { page1Total: number | null } = { page1Total: null };
    return paginate<NormalizedPosting>({
      provider: "radancy",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      // Termination is a zero-job page (defensive backstop) or reaching data-total-results, read
      // once from page 1 and never reconsidered.
      shortPageEndsPagination: false,
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(radancyListUrl(company.careersUrl, page + 1), {
          provider: "radancy",
          userAgent: BROWSER_UA,
        });
        const items = parseRadancyList(html, company);
        const { totalResults } = parseRadancyTotals(html);
        // Only page 1, and only when it produced no cards: a page with rows is a live board
        // whatever its pager markup says, and a pager running off the end on a later page just stops.
        if (page === 0 && items.length === 0) {
          assertRadancyBoardServed(totalResults, radancyListUrl(company.careersUrl, 1), html);
        }
        if (page === 0) state.page1Total = totalResults;
        // Location-scoped boards can drop the scope when ?p=N is appended, silently merging foreign
        // postings into the result set. A page whose own reported total differs from page 1's is
        // answering a different query - discard it and stop.
        if (page > 0 && state.page1Total !== null && totalResults !== null && totalResults !== state.page1Total) {
          logger.warn(
            { slug: company.slug, page: page + 1, page1Total: state.page1Total, pageTotal: totalResults },
            "radancy page answered a different query than page 1 (location scope dropped) - discarding page and stopping",
          );
          return { items: [], total: state.page1Total };
        }
        return { items, total: totalResults };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "radancy", userAgent: BROWSER_UA });
    return parseRadancyJd(html);
  },
};
