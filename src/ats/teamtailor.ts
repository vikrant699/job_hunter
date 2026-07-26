// src/ats/teamtailor.ts — Teamtailor career sites (https://<slug>.teamtailor.com).
// The board page /jobs?page=N is SERVER-RENDERED: <ul id="jobs_list_container">
// with one <li> per job linking to /jobs/<id>-<slug>. Job links may point at a
// custom domain (e.g. jobs.storytel.com) even when browsing the teamtailor.com
// host, so parsing keys on the /jobs/<id>- path, not the host. Pages hold 20
// jobs (verified on polestar: p1=20, p2=6, p3=0); only an EMPTY page ends
// pagination — the per-page count is theme-dependent, so a short page doesn't.
// JD comes from the job detail page's JSON-LD JobPosting island, whose
// description is entity-encoded HTML (decode once, then strip); fallback is the
// server-rendered <main> .prose block.
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin } from "./shared.js";
import { tryParseJson } from "../util/json.js";

const PAGE = 20;
const JOB_HREF_RE = /\/jobs\/(\d+)(?:-|\/|\?|#|$)/;
// Workplace chips rendered next to the location (e.g. "Hybrid · <wifi icon>").
const WORKPLACE_RE = /^(hybrid|remote|fully remote|on-?site|office)$/i;

const TeamtailorJobPostingSchema = z.object({
  "@type": z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  datePosted: z.string().nullable().optional(),
});
export type TeamtailorJobPosting = z.infer<typeof TeamtailorJobPostingSchema>;

/** Paged board URL: https://<slug>.teamtailor.com/jobs?page=N (1-based). */
export function teamtailorJobsUrl(company: AdapterCompany, page: number): string {
  return `${tenantOrigin(company)}/jobs?page=${page}`;
}

/** Collapse whitespace runs — board titles/locations span multiple source lines. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse one board page. Returns null when the page has no
 * #jobs_list_container at all (structure change / not a board page) so the
 * caller can fail loudly on page 1, vs [] for a present-but-empty board
 * (a legitimate zero-job tenant or the page past the last one).
 */
export function parseTeamtailorList(company: AdapterCompany, html: string): NormalizedPosting[] | null {
  const $ = cheerio.load(html);
  const container = $("#jobs_list_container");
  if (container.length === 0) return null;

  const out: NormalizedPosting[] = [];
  container.find("li").each((_i, li) => {
    const $li = $(li);
    // The job anchor is the one whose href matches /jobs/<id>-…
    const anchor = $li
      .find("a[href]")
      .filter((_j, a) => JOB_HREF_RE.test($(a).attr("href") ?? ""))
      .first();
    if (anchor.length === 0) return;
    const href = anchor.attr("href") ?? "";
    const idMatch = href.match(JOB_HREF_RE);
    if (!idMatch?.[1]) return;

    // Variant B (block-grid) carries the title in span[title]; variant A's
    // anchor text IS the title (minus the meta div, present only in B).
    const titleAttr = anchor.find("span[title]").first().attr("title");
    let title: string;
    if (titleAttr) {
      title = clean(titleAttr);
    } else {
      const stripped = anchor.clone();
      stripped.find("div").remove();
      title = clean(stripped.text());
    }
    if (!title) return;

    // Meta spans: [department?] · location? · [workplace chip?]. The location
    // is the LAST non-workplace span; a lone workplace span means no location.
    const fields: string[] = [];
    const workplace: string[] = [];
    $li.find('div[class*="mt-1"] span').each((_j, span) => {
      const text = clean($(span).text());
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

/** First JSON-LD island whose @type is JobPosting, or null. */
export function extractTeamtailorJobPosting(html: string): TeamtailorJobPosting | null {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const rawText = $(el).text();
    const parsedJson = tryParseJson(rawText);
    if (parsedJson === null) continue;
    const parsed = TeamtailorJobPostingSchema.safeParse(parsedJson);
    if (parsed.success && parsed.data["@type"] === "JobPosting") return parsed.data;
  }
  return null;
}

/**
 * JD text from a job detail page. The JSON-LD description is entity-encoded
 * HTML (&lt;p&gt;…), so htmlToText runs twice: pass 1 decodes entities into
 * real HTML, pass 2 strips the tags. (Double-stripping already-plain HTML is
 * harmless.) Fallback: the server-rendered <main> .prose content block.
 */
export function teamtailorJdFromHtml(html: string): string {
  const ld = extractTeamtailorJobPosting(html);
  if (ld?.description) return htmlToText(htmlToText(ld.description));
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
      // Page size is theme-configurable, so a short page is NOT authoritative;
      // only an empty page (or the page cap) ends the loop.
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
