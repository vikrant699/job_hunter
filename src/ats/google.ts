// src/ats/google.ts — Google Careers (google.com/about/careers/applications).
//
// Single-tenant (Google's own boq-hiring "Cportal"). The public JSON API
// (careers.google.com/api/v3/search) is retired (404), but the results and
// detail pages are fully SERVER-RENDERED, so a plain fetch + cheerio suffices —
// no browser, no XHR. Parsing keys on STRUCTURE and STABLE HEADING TEXT, never
// on Google's rotating obfuscated CSS class names:
//
//   list: GET .../jobs/results?location=India&page=<n>   (1-based)
//         -> <li> cards, each with an <a href="jobs/results/<id>-<slug>?…"> and
//            an <h3> clean title. 20 cards/page; paginate until a short/empty page.
//   jd:   GET .../jobs/results/<id>-<slug>  -> the JD lives in the smallest block
//         that contains the <h3> sections "About the job" / "Minimum
//         qualifications" / "Preferred qualifications" / "Responsibilities".
//
// location is fixed to "India" (the list is India-filtered); the detail page
// carries per-city text but the India country filter only needs the country.
// Verified live 2026-08-13 (321 India postings).
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const APP_BASE = "https://www.google.com/about/careers/applications";
const RESULTS_BASE = `${APP_BASE}/jobs/results`;
const PAGE = 20; // Google serves 20 cards per results page.

// Stable JD section headings — Google keeps this wording; classes rotate.
const JD_HEADING_RE = /About the job|Minimum qualifications|Preferred qualifications|Responsibilities/;
// jobs/results/<numericId>-<slug> (the id is the numeric prefix).
const RESULT_HREF_RE = /jobs\/results\/(\d+)-[a-z0-9-]+/i;

export function googleListUrl(page: number): string {
  return `${RESULTS_BASE}?location=India&page=${page}`;
}

/** Absolute detail URL from a card's (possibly relative, query-carrying) href. */
export function googleDetailUrl(href: string): string {
  const m = href.match(/jobs\/results\/(\d+-[a-z0-9-]+)/i);
  const path = m?.[1];
  return path ? `${RESULTS_BASE}/${path}` : href;
}

export function parseGoogleList(company: AdapterCompany, html: string): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();

  $("li").each((_, li) => {
    const $li = $(li);
    const href = $li.find("a[href*='jobs/results/']").first().attr("href");
    if (!href) return;
    const id = href.match(RESULT_HREF_RE)?.[1];
    if (!id || seen.has(id)) return;
    const title = $li.find("h3").first().text().trim();
    if (!title) return;

    seen.add(id);
    out.push({
      provider: "google",
      externalId: id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: googleDetailUrl(href),
      location: "India",
      isRemote: REMOTE_RE.test(title),
      jdText: "",
      postedAt: null,
    });
  });
  return out;
}

/** JD text from a detail page: the smallest ancestor block that holds all of the
 *  stable JD-section <h3>s, taken from the first such <h3> onward (so page chrome
 *  above it — share links, breadcrumb — is dropped). "" when no sections found. */
export function parseGoogleJd(html: string): string {
  const $ = cheerio.load(html);
  const jdHeads = $("h3").filter((_, e) => JD_HEADING_RE.test($(e).text()));
  if (jdHeads.length === 0) return "";

  // Climb to the smallest ancestor containing every JD heading.
  let container = jdHeads.first().parent();
  for (let i = 0; i < 6; i++) {
    const hits = container.find("h3").filter((_, e) => JD_HEADING_RE.test($(e).text())).length;
    if (hits >= jdHeads.length) break;
    const up = container.parent();
    if (up.length === 0) break;
    container = up;
  }

  // Keep only the first JD heading onward (drop share/breadcrumb chrome before it).
  const parts: string[] = [];
  let started = false;
  container.children().each((_, el) => {
    const $el = $(el);
    if (!started && $el.find("h3").addBack("h3").filter((_, e) => JD_HEADING_RE.test($(e).text())).length > 0) {
      started = true;
    }
    if (started) parts.push($el.text());
  });
  const text = htmlToText(parts.join("\n"));
  // Fallback: if the child-walk found nothing (headings nested oddly), take the
  // whole container text — still far better than an empty JD.
  return text.trim() ? text : htmlToText(container.text());
}

export const googleAdapter: AtsAdapter = {
  provider: "google",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "google",
      company: company.slug,
      pageSize: PAGE,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(googleListUrl(page + 1), { provider: "google" });
        const items = parseGoogleList(company, html);
        return { items, total: null, rawCount: items.length };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "google" });
    return parseGoogleJd(html);
  },
};
