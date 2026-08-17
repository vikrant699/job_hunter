// src/ats/freshteam.ts — Freshteam (Freshworks) career sites, one tenant per subdomain (<tenant>.freshteam.com), server-rendered, no auth.
// list: GET <origin>/jobs (all postings inline, no pagination); jd: GET /jobs/<id>/<slug> -> .job-details-content (apply form stripped). Legacy /api/job_postings endpoint 401s, don't use it.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, tenantOrigin, collapseWs } from "./shared.js";

/** The one (unpaginated) listing page. */
export function freshteamListUrl(company: AdapterCompany): string {
  return `${tenantOrigin(company)}/jobs`;
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

// A nonexistent subdomain still answers HTTP 200 with Freshteam's own "claim it now" page (no jobs_list
// container) instead of a 404 — detected via INVALID_DOMAIN_SELECTOR, distinct from a genuinely empty
// board's `.no-jobs-found` / `[data-portal-id="no_data"]`, which must keep returning [].
const INVALID_DOMAIN_SELECTOR = ".invalid-domain-wrapper, .no-ats";

/** Parse the /jobs listing into postings; throws on Freshteam's invalid-domain page (see INVALID_DOMAIN_SELECTOR). */
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

    const title = collapseWs($a.find(".job-title").first().text());
    if (!title) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, base).toString();
    } catch {
      return;
    }

    const location = collapseWs($a.attr("data-portal-location") ?? "") || null;
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

  // Legacy template fallback: bare a.job-title anchors in .job-list-info rows, location in a sibling
  // .job-location block; only consulted when the data-portal pass found nothing, so a board with both never double-counts.
  if (postings.length === 0) {
    $(".job-list-info a.job-title").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href");
      if (!href) return;
      const parsed = parseFreshteamHref(href);
      if (!parsed) return;
      if (seen.has(parsed.id)) return;

      const title = collapseWs($a.text());
      if (!title) return;

      let jobUrl: string;
      try {
        jobUrl = new URL(href, base).toString();
      } catch {
        return;
      }

      // First <br/>-separated line of .location-info is the location; the rest is employment type, not location.
      const locationHtml = $a.closest(".row").find(".job-location .location-info").first().html() ?? "";
      const location = collapseWs(cheerio.load(locationHtml.split(/<br\s*\/?>/i)[0] ?? "").text()) || null;

      seen.add(parsed.id);
      postings.push({
        provider: "freshteam",
        externalId: parsed.id,
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: title,
        jobUrl,
        location,
        isRemote: location ? REMOTE_RE.test(location) : false,
        jdText: "",
        postedAt: null,
      });
    });
  }

  // Checked only when the parse yields nothing, so a marker collision can't fail a board that has rows;
  // the URL comes from the company row since the served page never names the tenant itself.
  if (postings.length === 0 && $(INVALID_DOMAIN_SELECTOR).length > 0) {
    throw new Error(
      `freshteam: tenant does not exist at ${freshteamListUrl(company)} — Freshteam served its ` +
        `invalid-domain page ("claim it now"). The subdomain is dead, not the board empty.`,
    );
  }

  return postings;
}

/** Extract the JD body (`.job-details-content`, apply form stripped) as plain text. */
export function parseFreshteamJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $(".job-details-content").first();
  if (!el.length) return "";
  el.find(".application-form, script, style").remove();
  const inner = el.html();
  return inner ? htmlToText(inner) : collapseWs(el.text());
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
