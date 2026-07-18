// src/ats/gohire.ts — GoHire (jobs.gohire.io) career boards, e.g.
// jobs.gohire.io/ikigai-infotech-llp-saleshandy-ilt9kdxu/.
//
// List: POST https://jobs.gohire.io/<tenant-slug>/ with an
// application/x-www-form-urlencoded body (page, remoteDdValue, typeDdValue,
// jobTitleSearched, cityOrCountrySearched) -> server-rendered HTML page of
// job cards, 10/page. A plain GET with ?page=N 404s — the POST body is
// mandatory. Paginate page+=1 until a page returns 0 cards.
//
// JD: each job's detail page (.../<job-slug>-<id>/) embeds a clean
// schema.org JobPosting JSON-LD island — reuse the shared JSON-LD parser.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchFormHtml, atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/json-ld.js";
import { REMOTE_RE, paginate } from "./shared.js";

const PAGE = 10;

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

/** Parse one list page's job cards into postings. Pure — unit tested directly. */
export function parseGohireListPage(html: string, company: AdapterCompany): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const out: NormalizedPosting[] = [];

  $("a.gohire-job").each((_, el) => {
    const href = $(el).attr("href");
    const externalId = href ? gohireExternalId(href) : null;
    const title = $(el).find("h3.job-title").text().trim();
    // No stable id or title — skip rather than emit a posting that would
    // collide on the (provider, external_id) dedup key.
    if (!href || !externalId || !title) return;

    const location = $(el).find("p.careers-location").text().trim() || null;
    const postedRaw = $(el).find("p.date-posted").text().trim().replace(/^Posted\s+/i, "");
    const postedMs = postedRaw ? Date.parse(postedRaw) : Number.NaN;

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
      postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
    });
  });

  return out;
}

export const gohireAdapter: AtsAdapter = {
  provider: "gohire",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const boardUrl = gohireBoardUrl(company);
    return paginate<NormalizedPosting>({
      provider: "gohire",
      company: company.slug,
      pageSize: PAGE,
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
        return { items: parseGohireListPage(html, company), total: null };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "gohire" });
    const [job] = extractJsonLdJobs(html);
    return job?.description ? htmlToText(job.description) : "";
  },
};
