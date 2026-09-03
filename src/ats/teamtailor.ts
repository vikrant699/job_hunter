// src/ats/teamtailor.ts — Teamtailor career sites (https://<slug>.teamtailor.com).
// List: /jobs?page=N is server-rendered, #jobs_list_container with one <li> per job linking to /jobs/<id>-<slug>. Detail: the job page's JSON-LD JobPosting island (entity-encoded HTML), falling back to the server-rendered <main> .prose block.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, paginate, tenantOrigin, collapseWs } from "./shared.js";

const PAGE = 20;
const JOB_HREF_RE = /\/jobs\/(\d+)(?:-|\/|\?|#|$)/;
// Workplace chips rendered next to the location (e.g. "Hybrid · <wifi icon>").
const WORKPLACE_RE = /^(hybrid|remote|fully remote|on-?site|office)$/i;

// Paged board URL: https://<slug>.teamtailor.com/jobs?page=N (1-based).
export function teamtailorJobsUrl(company: AdapterCompany, page: number): string {
  return `${tenantOrigin(company)}/jobs?page=${page}`;
}

// Returns null when the page has no #jobs_list_container at all (structure change / not a board page), vs [] for a present-but-empty board — callers fail loudly on page 1 only.
export function parseTeamtailorList(company: AdapterCompany, html: string): NormalizedPosting[] | null {
  const $ = cheerio.load(html);
  const container = $("#jobs_list_container");
  if (container.length === 0) return null;

  const out: NormalizedPosting[] = [];
  container.find("li").each((_i, li) => {
    const $li = $(li);
    // The job anchor is the one whose href matches /jobs/<id>-… (job links may point at a custom domain even when browsing the teamtailor.com host, so parsing keys on this path pattern, not the host).
    const anchor = $li
      .find("a[href]")
      .filter((_j, a) => JOB_HREF_RE.test($(a).attr("href") ?? ""))
      .first();
    if (anchor.length === 0) return;
    const href = anchor.attr("href") ?? "";
    const idMatch = href.match(JOB_HREF_RE);
    if (!idMatch?.[1]) return;

    // Variant B (block-grid) carries the title in span[title]; variant A's anchor text IS the title.
    const titleAttr = anchor.find("span[title]").first().attr("title");
    let title: string;
    if (titleAttr) {
      title = collapseWs(titleAttr);
    } else {
      const stripped = anchor.clone();
      stripped.find("div").remove();
      title = collapseWs(stripped.text());
    }
    if (!title) return;

    // Meta spans: [department?] · location? · [workplace chip?]. Location is the LAST non-workplace span.
    const fields: string[] = [];
    const workplace: string[] = [];
    $li.find('div[class*="mt-1"] span').each((_j, span) => {
      const text = collapseWs($(span).text());
      if (!text || text === "·") return;
      if (WORKPLACE_RE.test(text)) workplace.push(text);
      else fields.push(text);
    });
    const location = fields.length > 0 ? (fields[fields.length - 1] ?? null) : null;

    out.push({
      provider: "teamtailor",
      externalId: idMatch[1],
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: new URL(href, tenantOrigin(company)).toString(),
      location,
      isRemote: REMOTE_RE.test(`${workplace.join(" ")} ${location ?? ""}`),
      jdText: "", // detail page only — fetched lazily via fetchJd
      postedAt: null, // board list carries no dates
    });
  });
  return out;
}

// JSON-LD description is entity-encoded HTML, so htmlToText runs twice: pass 1 decodes entities into real HTML, pass 2 strips the tags (double-stripping plain HTML is harmless).
export function teamtailorJdFromHtml(html: string): string {
  const [job] = extractJsonLdJobs(html);
  if (job?.description) return htmlToText(htmlToText(job.description));
  const $ = cheerio.load(html);
  const prose = $("main .prose").first();
  return prose.length > 0 ? htmlToText(prose.html() ?? "") : "";
}

export const teamtailorAdapter: AtsAdapter = {
  provider: "teamtailor",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const postings = await paginate<NormalizedPosting>({
      provider: "teamtailor",
      company: company.slug,
      pageSize: PAGE,
      // Page size is theme-configurable, so a short page is NOT authoritative.
      shortPageEndsPagination: false,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(teamtailorJobsUrl(company, page + 1), { provider: "teamtailor" });
        const items = parseTeamtailorList(company, html);
        if (items === null) {
          if (page === 0) throw new Error(`teamtailor: no #jobs_list_container on board page for ${company.slug}`);
          return { items: [], total: null };
        }
        return { items, total: null };
      },
    });
    // A job shifting between pages mid-crawl could repeat — dedupe on id.
    const seen = new Set<string>();
    return postings.filter((p) => (seen.has(p.externalId) ? false : (seen.add(p.externalId), true)));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "teamtailor" });
    return teamtailorJdFromHtml(html);
  },
};
