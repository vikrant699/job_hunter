// src/ats/gohire.ts — GoHire (jobs.gohire.io) career boards, e.g.
// jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/.
//
// List: POST https://jobs.gohire.io/<tenant-slug>/ with an
// application/x-www-form-urlencoded body (page, remoteDdValue, typeDdValue,
// jobTitleSearched, cityOrCountrySearched) -> server-rendered HTML page of
// job cards (10/page on the tenants seen so far, but the request never states
// a size, so the loop infers it from page 1 rather than assuming). Paginate
// page+=1 until a page returns 0 cards — or, on a tenant that clamps instead of
// emptying, until a page repeats (see `dedupeBy` below). POST is what the
// board's own pager submits; a GET with ?page=N used to 404 but served page N
// when re-checked on 2026-08-04, so keep the POST rather than trust the drift.
//
// JD: each job's detail page (.../<job-slug>-<id>/) embeds a clean
// schema.org JobPosting JSON-LD island — reuse the shared JSON-LD parser.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchFormHtml, atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/json-ld.js";
import { REMOTE_RE, paginate, dateToIso, collapseWs } from "./shared.js";

/** Board URL for a tenant, e.g. "https://jobs.gohire.io/<slug>/". The tenant
 *  slug is the company's registry slug (source_slug = tenant). */
export function gohireBoardUrl(company: AdapterCompany): string {
  return `https://jobs.gohire.io/${company.apiMeta?.boardSlug ?? company.slug}/`;
}

/** The stable id is the numeric suffix on the job-slug path segment, e.g.
 *  ".../senior-content-marketer-292750/" -> "292750". Null if the href
 *  doesn't match that shape (never a bare numeric id to collide on dedup). */
export function gohireExternalId(href: string): string | null {
  const m = href.match(/-(\d+)\/?$/);
  return m ? (m[1] ?? null) : null;
}

/**
 * What the board's own pagination control says, if it renders one.
 *
 * Three states, not `number | null`, because "no pager" and "pager I could not
 * read" are opposite claims. GoHire omits the pagination block entirely below
 * one page — verified 2026-08-04 on all five single-page tenants (edwisely,
 * piersight, supergaming, rankwatch, 2YFKBlAY: no `jobs-pagination` element at
 * all) versus the multi-page ikigai tenant, which renders it on every page
 * including out-of-range ones. So `absent` is positive evidence that the single
 * page we fetched IS the whole board, while `unparsed` proves nothing either
 * way. Collapsing them would let a real truncation claim completeness.
 */
export type GohirePager =
  | { kind: "absent" }
  | { kind: "unparsed" }
  | { kind: "present"; page: number; totalPages: number; totalJobs: number };

// "Page 1 of 3, Total 26 jobs" — matched against the element's TEXT with
// whitespace collapsed, so the <strong> wrappers around each number (and any
// future re-tagging or line wrapping) are irrelevant. The comma is optional
// and "job"/"jobs" both accepted; anything else is `unparsed`, never a guess.
const PAGER_RE = /page\s+(\d+)\s+of\s+(\d+)\s*,?\s*total\s+(\d+)\s+jobs?/i;

// Class-substring match rather than the literal `p.gohire-job-pagination-results`
// so a tag or class-prefix change still finds it. Deliberately NOT matched on
// the wrapper (`.jobs-pagination`), whose Prev/Next buttons carry no counts.
const PAGER_SELECTOR = '[class*="pagination-results"]';

/** Read the pager's three numbers out of its rendered text. */
function parseGohirePager($: cheerio.CheerioAPI): GohirePager {
  const el = $(PAGER_SELECTOR).first();
  if (el.length === 0) return { kind: "absent" };

  const m = collapseWs(el.text()).match(PAGER_RE);
  if (!m) return { kind: "unparsed" };
  const page = Number(m[1]);
  const totalPages = Number(m[2]);
  const totalJobs = Number(m[3]);
  // A matched `\d+` is never negative, but it can be long enough to lose
  // precision as a double, and `noUncheckedIndexedAccess` allows for a missing
  // group (Number(undefined) === NaN). Both land here: a number we cannot use
  // is `unparsed`, never a bogus total that pagination would then treat as
  // authoritative. "Page 1 of 0" is likewise nonsense, not a one-page board.
  if (![page, totalPages, totalJobs].every(Number.isSafeInteger) || totalPages < 1) return { kind: "unparsed" };
  return { kind: "present", page, totalPages, totalJobs };
}

/**
 * Parse one list page's job cards into postings. Pure — unit tested directly.
 *
 * `rawCount` is how many cards the server actually rendered, which is NOT
 * `postings.length`: a card with no href/id/title is dropped below. Pagination
 * has to measure the page against the server's count, because a full page that
 * happens to contain one unparseable card would otherwise look short and end
 * the board mid-crawl.
 *
 * `pager` is the board's own account of its size — see `GohirePager`.
 */
export function parseGohireListPage(
  html: string,
  company: AdapterCompany,
): { postings: NormalizedPosting[]; rawCount: number; pager: GohirePager } {
  const $ = cheerio.load(html);
  const out: NormalizedPosting[] = [];
  const cards = $("a.gohire-job");

  cards.each((_, el) => {
    const href = $(el).attr("href");
    const externalId = href ? gohireExternalId(href) : null;
    const title = $(el).find("h3.job-title").text().trim();
    // No stable id or title — skip rather than emit a posting that would
    // collide on the (provider, external_id) dedup key.
    if (!href || !externalId || !title) return;

    const location = $(el).find("p.careers-location").text().trim() || null;
    const postedRaw = $(el).find("p.date-posted").text().trim().replace(/^Posted\s+/i, "");

    out.push({
      provider: "gohire",
      externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: href,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: "",
      postedAt: dateToIso(postedRaw),
    });
  });

  return { postings: out, rawCount: cards.length, pager: parseGohirePager($) };
}

export const gohireAdapter: AtsAdapter = {
  provider: "gohire",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const boardUrl = gohireBoardUrl(company);
    return paginate<NormalizedPosting>({
      provider: "gohire",
      company: company.slug,
      // Latched from the tenant's own first page. A declared 10 was a guess
      // about the product — nothing in the request tells the server a page
      // size — and any tenant serving fewer had page 1 judged short and the
      // board truncated there, silently, on every run.
      pageSize: "infer",
      // A tenant that clamps an out-of-range `page` back to page 1 instead of
      // returning an empty one has only the exact-page-repeat stall guard left
      // as a terminator before the runaway cap — and it only sees the repeat if
      // items have a stable key. Every single-page tenant does exactly this
      // (all five, 2026-08-04), and none of them publishes a total.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchFormHtml(
          boardUrl,
          {
            page: String(page + 1),
            remoteDdValue: "all_Id",
            typeDdValue: "0",
            jobTitleSearched: "",
            cityOrCountrySearched: "",
          },
          { provider: "gohire" },
        );
        const { postings, rawCount, pager } = parseGohireListPage(html, company);
        return {
          items: postings,
          // The board's own count, so a stall that loses rows can be SEEN.
          // Verified against ikigai on 2026-08-04: pager "Total 26 jobs" and
          // the cards it actually served (10 + 10 + 6) agree exactly.
          total: pager.kind === "present" ? pager.totalJobs : null,
          rawCount,
          noPaginationControl: pager.kind === "absent",
        };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "gohire" });
    const [job] = extractJsonLdJobs(html);
    return job?.description ? htmlToText(job.description) : "";
  },
};
