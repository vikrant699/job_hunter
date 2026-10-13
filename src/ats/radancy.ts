// POST the landing page's #search-results query with CurrentPage=N to data-ajax-post-url (JSON {results: html}); pages without it fall back to ?p=N
// every request uses a browser UA: WAF/CDN blocks the bot UA on some routes
import * as cheerio from "cheerio";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, tenantOrigin, collapseWs } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import type { JsonValue } from "../util/json.js";

const NOMINAL_PAGE_SIZE = 15;

const TOTAL_PAGES_RE = /data-total-pages="(\d+)"/;
const TOTAL_RESULTS_RE = /data-total-results="(\d+)"/;

// data-total-results is emitted whatever the count, so its total absence (not a zero count) is what means the board is dead; a WAF challenge page also lacks it, so that's checked first and treated as infrastructure rather than charged to the row.
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

const JD_CLASS_TIERS = ["ats-description", "job-description", "__description"];

export function radancyListUrl(careersUrl: string, page: number): string {
  if (page <= 1) return careersUrl;
  const sep = careersUrl.includes("?") ? "&" : "?";
  return `${careersUrl}${sep}p=${page}`;
}

// Mirrors the site's search.js mapSearchOptions; ?p=N on a /search-jobs/<keyword> landing page silently drops the keyword, the results endpoint does not.
const INT_CRITERIA = [
  ["ActiveFacetID", "active-facet-id"],
  ["RecordsPerPage", "records-per-page"],
  ["Distance", "distance"],
  ["FacetType", "facet-type"],
  ["SortCriteria", "sort-criteria"],
  ["SortDirection", "sort-direction"],
  ["SearchType", "search-type"],
] as const;
const FLOAT_CRITERIA = [
  ["Latitude", "latitude"],
  ["Longitude", "longitude"],
] as const;
const STRING_CRITERIA = [
  ["Keywords", "keywords"],
  ["Location", "location"],
  ["CustomFacetName", "custom-facet-name"],
  ["FacetTerm", "facet-term"],
  ["SearchResultsModuleName", "search-results-module-name"],
  ["KeywordType", "keyword-type"],
  ["LocationType", "location-type"],
  ["LocationPath", "location-path"],
  ["OrganizationIds", "organization-ids"],
  ["PostalCode", "postal-code"],
] as const;
// The pager's Next link asks for jobs only, so totals exclude content-page hits.
const RESULTS_TYPE_JOBS = 1;

const RadancyResultsSchema = z.object({ results: z.string() });

export interface RadancySearch {
  postUrl: string;
  criteria: { [k: string]: JsonValue };
}

// Checked .filter-checkbox inputs are the facets the landing URL applied (Ford's /location/ pages scope by one), and the endpoint ignores the path, so they must be resent.
export function parseRadancySearch(html: string, careersUrl: string): RadancySearch | null {
  const $ = cheerio.load(html);
  const $sec = $("#search-results").first();
  const postPath = $sec.attr("data-ajax-post-url");
  if (!postPath) return null;

  const criteria: { [k: string]: JsonValue } = {};
  for (const [key, attr] of INT_CRITERIA) {
    const n = Number.parseInt($sec.attr(`data-${attr}`) ?? "", 10);
    if (Number.isFinite(n)) criteria[key] = n;
  }
  for (const [key, attr] of FLOAT_CRITERIA) {
    const n = Number.parseFloat($sec.attr(`data-${attr}`) ?? "");
    if (Number.isFinite(n)) criteria[key] = n;
  }
  for (const [key, attr] of STRING_CRITERIA) {
    const v = $sec.attr(`data-${attr}`);
    if (v) criteria[key] = v;
  }
  criteria.ResultsType = RESULTS_TYPE_JOBS;

  const facets: JsonValue[] = [];
  const seen = new Set<string>();
  $(".filter-checkbox:checked").each((_, el) => {
    const $cb = $(el);
    const id = $cb.attr("data-id") ?? "";
    const facetType = Number.parseInt($cb.attr("data-facet-type") ?? "", 10);
    const key = `${facetType}|${id}`;
    if (!id || !Number.isFinite(facetType) || seen.has(key)) return;
    seen.add(key);
    const count = Number.parseInt($cb.attr("data-count") ?? "", 10);
    facets.push({
      ID: id,
      FacetType: facetType,
      Count: Number.isFinite(count) ? count : 0,
      Display: $cb.attr("data-display") ?? "",
      IsApplied: true,
      FieldName: $cb.attr("data-field-name") ?? "",
    });
  });
  criteria.FacetFilters = facets;

  let postUrl: string;
  try {
    postUrl = new URL(postPath, careersUrl).toString();
  } catch {
    return null;
  }
  return { postUrl, criteria };
}

async function fetchRadancyResults(search: RadancySearch, page: number, slug: string): Promise<string> {
  const raw = await atsFetchJson(search.postUrl, {
    method: "POST",
    body: { ...search.criteria, CurrentPage: page },
    provider: "radancy",
    userAgent: BROWSER_UA,
  });
  return parseOrThrow(RadancyResultsSchema, raw, { provider: "radancy", slug, what: "search results" }).results;
}

export function parseRadancyTotals(html: string): { totalPages: number | null; totalResults: number | null } {
  const pagesMatch = TOTAL_PAGES_RE.exec(html);
  const resultsMatch = TOTAL_RESULTS_RE.exec(html);
  return {
    totalPages: pagesMatch?.[1] ? Number(pagesMatch[1]) : null,
    totalResults: resultsMatch?.[1] ? Number(resultsMatch[1]) : null,
  };
}

export function parseRadancyJobId(href: string): string | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  return last && /^\d+$/.test(last) ? last : null;
}

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

      // Newer Radancy themes (disneycareers.com) wrap the title in an <h2> beside brand/location/date spans; older ones put bare text in the anchor.
      const $heading = $a.find('h2, h3, [class*="job-title"]').first();
      const $titleClone = $a.clone();
      $titleClone.find('[class*="job-location"], span.location, [class*="job-brand"], [class*="job-date"]').remove();
      const title = collapseWs($heading.length ? $heading.text() : $titleClone.text());
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

// The largest matching block in the first non-empty tier — Ford's outer .job-description wrapper would otherwise out-rank the real .ats-description body.
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
    const state: { page1Total: number | null; search: RadancySearch | null } = { page1Total: null, search: null };
    return paginate<NormalizedPosting>({
      provider: "radancy",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      shortPageEndsPagination: false,
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        let html: string;
        if (page === 0) {
          const landing = await atsFetchText(company.careersUrl, { provider: "radancy", userAgent: BROWSER_UA });
          state.search = parseRadancySearch(landing, company.careersUrl);
          // Page 1 comes from the endpoint too: the landing HTML can be a stale cached copy whose total disagrees with the live pages.
          html = state.search ? await fetchRadancyResults(state.search, 1, company.slug) : landing;
        } else {
          html = state.search
            ? await fetchRadancyResults(state.search, page + 1, company.slug)
            : await atsFetchText(radancyListUrl(company.careersUrl, page + 1), { provider: "radancy", userAgent: BROWSER_UA });
        }
        const items = parseRadancyList(html, company);
        const { totalResults } = parseRadancyTotals(html);
        // Only page 1, and only when it produced no cards: a page with rows is a live board whatever its pager markup says, and a pager running off the end on a later page just stops.
        if (page === 0 && items.length === 0) {
          assertRadancyBoardServed(totalResults, radancyListUrl(company.careersUrl, 1), html);
        }
        if (page === 0) state.page1Total = totalResults;
        // Safety net: a page whose own reported total differs from page 1's is answering a different query (scope dropped, merging foreign postings) - discard it and stop.
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
