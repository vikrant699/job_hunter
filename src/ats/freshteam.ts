// src/ats/freshteam.ts — Freshteam (Freshworks) career sites, one tenant per
// subdomain: <tenant>.freshteam.com. The board is server-rendered, no auth:
//
//   list: GET <origin>/jobs -> ALL postings inline in one page, no pagination.
//         <div data-portal-id="jobs_list"> wraps one
//           <a href="/jobs/<id>/<slug>" data-portal-title=".." data-portal-location=".."
//              data-portal-job-type=".." data-portal-remote-location=true|false>
//         per posting. The display title lives in a nested
//         `<div class="job-title">` — `data-portal-title` is a lowercased,
//         whitespace-stripped slug of it, not display text.
//
//   jd:   GET <origin>/jobs/<id>/<slug> -> full rich HTML in
//         `.job-details-content`. That div also contains the apply form
//         (`.application-form` + a portal <script>) as trailing siblings of
//         the JD markup, so those are stripped before converting to text.
//
// The legacy `/api/job_postings` endpoint 401s — do not use it.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin } from "./shared.js";

/** The one (unpaginated) listing page. */
export function freshteamListUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/jobs`;
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** id + slug from a "/jobs/<id>/<slug>" href. Null when the shape doesn't match. */
export function parseFreshteamHref(href: string): { id: string; slug: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  if (segs.length < 3 || segs[0] !== "jobs") return null;
  const id = segs[1];
  const slug = segs[2];
  if (!id || !slug) return null;
  return { id, slug };
}

/** Parse the /jobs listing page into postings. Tolerates a missing or empty
 *  jobs_list container (returns []) and skips any row missing an href, id, or
 *  title. Dedups by job id in case markup ever renders a row twice. */
export function parseFreshteamList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const base = tenantOrigin(company);
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];
  const seen = new Set<string>();

  $('[data-portal-id="jobs_list"] a[data-portal-title]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    const parsed = parseFreshteamHref(href);
    if (!parsed) return;
    if (seen.has(parsed.id)) return;

    const title = cleanText($a.find(".job-title").first().text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, base).toString();
    } catch {
      return;
    }

    const location = cleanText($a.attr("data-portal-location") ?? "") || null;
    const isRemote =
      $a.attr("data-portal-remote-location") === "true" ||
      (location ? REMOTE_RE.test(location) : false);

    seen.add(parsed.id);
    postings.push({
      provider: "freshteam",
      externalId: parsed.id,
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

/** Extract the JD body (`.job-details-content`, apply form stripped) as plain text. */
export function parseFreshteamJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $(".job-details-content").first();
  if (!el.length) return "";
  el.find(".application-form, script, style").remove();
  const inner = el.html();
  return inner ? htmlToText(inner) : cleanText(el.text());
}

export const freshteamAdapter: AtsAdapter = {
  provider: "freshteam",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(freshteamListUrl(company), { provider: "freshteam" });
    return parseFreshteamList(html, company);
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "freshteam" });
    return parseFreshteamJd(html);
  },
};
