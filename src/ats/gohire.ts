// src/ats/gohire.ts — GoHire (jobs.gohire.io) career boards, no public JSON API.
// list: POST <board>/ (form: page, remoteDdValue, typeDdValue, jobTitleSearched, cityOrCountrySearched) ->
// server-rendered HTML; page size inferred from page 1, paginate until a page returns 0 cards or repeats.
// jd: detail page's schema.org JobPosting JSON-LD island.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchFormHtml, atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, paginate, dateToIso, collapseWs } from "./shared.js";

/** Board URL for a tenant, e.g. "https://jobs.gohire.io/<slug>/" (slug = registry source_slug). */
export function gohireBoardUrl(company: AdapterCompany): string {
  return `https://jobs.gohire.io/${company.apiMeta?.boardSlug ?? company.slug}/`;
}

/** Stable id is the numeric suffix on the job-slug path segment, e.g. ".../senior-content-marketer-292750/" -> "292750". */
export function gohireExternalId(href: string): string | null {
  const m = href.match(/-(\d+)\/?$/);
  return m ? (m[1] ?? null) : null;
}

/** Three states, not `number | null`: "absent" (no pager block rendered) is positive proof the single page
 *  fetched IS the whole board; "unparsed" proves nothing either way. Collapsing them would let a real
 *  truncation claim completeness. */
export type GohirePager =
  | { kind: "absent" }
  | { kind: "unparsed" }
  | { kind: "present"; page: number; totalPages: number; totalJobs: number };

// Matches "Page 1 of 3, Total 26 jobs" against whitespace-collapsed text (tag-agnostic); anything else is unparsed, never guessed.
const PAGER_RE = /page\s+(\d+)\s+of\s+(\d+)\s*,?\s*total\s+(\d+)\s+jobs?/i;

// Class-substring match (not the literal tag) so a class-prefix change still finds it; deliberately not the
// `.jobs-pagination` wrapper, whose Prev/Next buttons carry no counts.
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
  // A number too large to represent exactly, or a missing regex group (NaN), lands here as unparsed rather
  // than a bogus authoritative total; "Page 1 of 0" is nonsense too, not a one-page board.
  if (![page, totalPages, totalJobs].every(Number.isSafeInteger) || totalPages < 1) return { kind: "unparsed" };
  return { kind: "present", page, totalPages, totalJobs };
}

/** Parse one list page's cards into postings. `rawCount` is the server's card count (not postings.length,
 *  since unparseable cards are dropped) so pagination isn't fooled into an early stop by a full page with
 *  one bad card. `pager` is the board's own account of its size — see `GohirePager`. */
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
      // Page size inferred from page 1: nothing in the request declares a size, so a fixed guess would
      // truncate any tenant serving fewer.
      pageSize: "infer",
      // Needed because a tenant that clamps an out-of-range `page` back to page 1 (rather than emptying)
      // relies on the exact-page-repeat stall guard, which needs a stable key to spot the repeat.
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
          // The board's own count, so a stall that loses rows is visible.
          total: pager.kind === "present" ? pager.totalJobs : null,
          rawCount,
          noPaginationControl: pager.kind === "absent",
        };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "gohire" });
    // Preferred: schema.org JobPosting island; falls back to div.jp-text for tenants that stopped emitting it.
    const [job] = extractJsonLdJobs(html);
    if (job?.description) return htmlToText(job.description);
    const $ = cheerio.load(html);
    const body = $("div.jp-text").first();
    const inner = body.length ? body.html() : null;
    return inner ? htmlToText(inner) : "";
  },
};
