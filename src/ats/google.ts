// list: GET .../jobs/results?location=India&page=<n> (1-based, 20/page); public JSON API is retired (404s), so this parses server-rendered HTML via cheerio
// jd: detail page; JD is the smallest block holding all of "About the job"/"Minimum qualifications"/"Preferred qualifications"/"Responsibilities" (stable headings, classes rotate)
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

/** JD text: the smallest ancestor block holding all stable JD-section <h3>s, from the first heading onward; "" when no sections found. */
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
  // Fallback: if the child-walk found nothing (headings nested oddly), take the whole container text.
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
