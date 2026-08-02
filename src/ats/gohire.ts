// src/ats/gohire.ts — GoHire (jobs.gohire.io) career boards, e.g.
// jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/.
//
// List: POST https://jobs.gohire.io/<tenant-slug>/ with an
// application/x-www-form-urlencoded body (page, remoteDdValue, typeDdValue,
// jobTitleSearched, cityOrCountrySearched) -> server-rendered HTML page of
// job cards (10/page on the tenants seen so far, but the request never states
// a size, so the loop infers it from page 1 rather than assuming). A plain GET
// with ?page=N 404s — the POST body is mandatory. Paginate page+=1 until a
// page returns 0 cards.
//
// JD: each job's detail page (.../<job-slug>-<id>/) embeds a clean
// schema.org JobPosting JSON-LD island — reuse the shared JSON-LD parser.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchFormHtml, atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/json-ld.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

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
 * Parse one list page's job cards into postings. Pure — unit tested directly.
 *
 * `rawCount` is how many cards the server actually rendered, which is NOT
 * `postings.length`: a card with no href/id/title is dropped below. Pagination
 * has to measure the page against the server's count, because a full page that
 * happens to contain one unparseable card would otherwise look short and end
 * the board mid-crawl.
 */
export function parseGohireListPage(
  html: string,
  company: AdapterCompany,
): { postings: NormalizedPosting[]; rawCount: number } {
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

  return { postings: out, rawCount: cards.length };
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
      // No total is published, so if a tenant ever clamps an out-of-range
      // `page` back to page 1 instead of returning an empty one, the
      // exact-page-repeat stall guard is the only terminator left before the
      // runaway cap — and it only sees the repeat if items have a stable key.
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
        const { postings, rawCount } = parseGohireListPage(html, company);
        return { items: postings, total: null, rawCount };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "gohire" });
    const [job] = extractJsonLdJobs(html);
    return job?.description ? htmlToText(job.description) : "";
  },
};
