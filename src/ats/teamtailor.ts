// List: /jobs?page=N, #jobs_list_container with an <li> per job linking /jobs/<id>-<slug>. Detail: the JSON-LD JobPosting island (entity-encoded HTML), else server-rendered <main> .prose.
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText, parseOrThrow } from "./http.js";
import { parseJsonOrThrow } from "../util/json.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, paginate, tenantOrigin, collapseWs } from "./shared.js";

const PAGE = 20;
const JOB_HREF_RE = /\/jobs\/(\d+)(?:-|\/|\?|#|$)/;
const WORKPLACE_RE = /^(hybrid|remote|fully remote|on-?site|office)$/i;

// JSON Feed every site serves regardless of theme; fallback when a custom jobs page has no #jobs_list_container (e.g. careers.lyzr.ai).
export function teamtailorFeedUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/jobs.json`;
}

const FeedSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        date_published: z.string().optional(),
        _jobposting: z.object({ description: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

/** Feed items carry no location; the pipeline's title/JD heuristic covers that. */
export function parseTeamtailorFeed(company: AdapterCompany, raw: string): NormalizedPosting[] {
  const feed = parseOrThrow(FeedSchema, parseJsonOrThrow(raw, "teamtailor feed"), { provider: "teamtailor", slug: company.slug });
  const out: NormalizedPosting[] = [];
  for (const item of feed.items) {
    const id = item.url.match(JOB_HREF_RE)?.[1];
    const title = collapseWs(item.title);
    if (!id || !title) continue;
    const description = item._jobposting?.description ?? "";
    out.push({
      provider: "teamtailor",
      externalId: id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: new URL(item.url, tenantOrigin(company)).toString(),
      location: null,
      isRemote: REMOTE_RE.test(title),
      jdText: description !== "" ? htmlToText(htmlToText(description)) : "",
      postedAt: item.date_published ?? null,
    });
  }
  return out;
}

export function teamtailorJobsUrl(company: AdapterCompany, page: number): string {
  return `${tenantOrigin(company)}/jobs?page=${page}`;
}

// null = no #jobs_list_container (structure change / not a board page); [] = present but empty; callers fail loudly on page 1 only.
export function parseTeamtailorList(company: AdapterCompany, html: string): NormalizedPosting[] | null {
  const $ = cheerio.load(html);
  const container = $("#jobs_list_container");
  if (container.length === 0) return null;

  const out: NormalizedPosting[] = [];
  container.find("li").each((_i, li) => {
    const $li = $(li);
    // Key on the /jobs/<id>-… path: job links may point at a custom domain even when browsing the teamtailor.com host.
    const anchor = $li
      .find("a[href]")
      .filter((_j, a) => JOB_HREF_RE.test($(a).attr("href") ?? ""))
      .first();
    if (anchor.length === 0) return;
    const href = anchor.attr("href") ?? "";
    const idMatch = href.match(JOB_HREF_RE);
    if (!idMatch?.[1]) return;

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

    // Spans: [department?] · location? · [workplace chip?]; location is the last non-workplace span.
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
      jdText: "",
      postedAt: null,
    });
  });
  return out;
}

// JSON-LD description is entity-encoded HTML: pass 1 decodes entities, pass 2 strips tags.
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
    // Custom themes drop the standard list container; the JSON Feed is theme-independent.
    const firstPage = await atsFetchText(teamtailorJobsUrl(company, 1), { provider: "teamtailor" });
    if (parseTeamtailorList(company, firstPage) === null) {
      const raw = await atsFetchText(teamtailorFeedUrl(company), { provider: "teamtailor" });
      return parseTeamtailorFeed(company, raw);
    }
    const postings = await paginate<NormalizedPosting>({
      provider: "teamtailor",
      company: company.slug,
      pageSize: PAGE,
      // Page size is theme-configurable, so a short page is NOT authoritative.
      shortPageEndsPagination: false,
      fetchPage: async (_offset, page) => {
        const html = page === 0 ? firstPage : await atsFetchText(teamtailorJobsUrl(company, page + 1), { provider: "teamtailor" });
        const items = parseTeamtailorList(company, html);
        if (items === null) return { items: [], total: null };
        return { items, total: null };
      },
    });
    const seen = new Set<string>();
    return postings.filter((p) => (seen.has(p.externalId) ? false : (seen.add(p.externalId), true)));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "teamtailor" });
    return teamtailorJdFromHtml(html);
  },
};
