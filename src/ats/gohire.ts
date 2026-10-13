// list: POST jobs.gohire.io/<board>/ (form: page, remoteDdValue, typeDdValue, jobTitleSearched, cityOrCountrySearched) -> server-rendered HTML
// jd: detail page's schema.org JobPosting JSON-LD island
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchFormHtml, atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, paginate, dateToIso, collapseWs } from "./shared.js";

export function gohireBoardUrl(company: AdapterCompany): string {
  return `https://jobs.gohire.io/${company.apiMeta?.boardSlug ?? company.slug}/`;
}

export function gohireExternalId(href: string): string | null {
  const m = href.match(/-(\d+)\/?$/);
  return m ? (m[1] ?? null) : null;
}

/** Three states, not number|null: "absent" proves the single page IS the whole board; "unparsed" proves nothing; collapsing them would let a real truncation claim completeness. */
export type GohirePager =
  | { kind: "absent" }
  | { kind: "unparsed" }
  | { kind: "present"; page: number; totalPages: number; totalJobs: number };

const PAGER_RE = /page\s+(\d+)\s+of\s+(\d+)\s*,?\s*total\s+(\d+)\s+jobs?/i;

// Class-substring match (not the literal tag) so a class-prefix change still finds it; not .jobs-pagination, whose Prev/Next buttons carry no counts.
const PAGER_SELECTOR = '[class*="pagination-results"]';

function parseGohirePager($: cheerio.CheerioAPI): GohirePager {
  const el = $(PAGER_SELECTOR).first();
  if (el.length === 0) return { kind: "absent" };

  const m = collapseWs(el.text()).match(PAGER_RE);
  if (!m) return { kind: "unparsed" };
  const page = Number(m[1]);
  const totalPages = Number(m[2]);
  const totalJobs = Number(m[3]);
  if (![page, totalPages, totalJobs].every(Number.isSafeInteger) || totalPages < 1) return { kind: "unparsed" };
  return { kind: "present", page, totalPages, totalJobs };
}

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
      pageSize: "infer",
      // Needed because a tenant that clamps an out-of-range page back to page 1 relies on the exact-page-repeat stall guard, which needs a stable key.
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
    if (job?.description) return htmlToText(job.description);
    const $ = cheerio.load(html);
    const body = $("div.jp-text").first();
    const inner = body.length ? body.html() : null;
    return inner ? htmlToText(inner) : "";
  },
};
