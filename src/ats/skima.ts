// src/ats/skima.ts — Skima AI careers sites (skima.ai), a shared careers-page vendor on custom domains (e.g. careers.nykaa.com), server-rendered by an Astro frontend - plain HTML, no JS or auth needed.
// List: GET <careersUrl>?page=N (1-based); each job card has a title anchor `<a href="/<uuid>">Title</a>` (a paired Apply-button anchor for the same uuid is text-less - keep the one with text) plus location/work-mode/type chips. Pages are disjoint; page until the "Showing X of N" total is reached, with a zero-item page as backstop. JD: div.job-description-panel on the same /<uuid> path.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, tenantOrigin, collapseWs } from "./shared.js";
import { matchGroup } from "../util/regex.js";

// Informational only - pagination doesn't rely on a fixed page size (see shortPageEndsPagination below).
const NOMINAL_PAGE_SIZE = 10;

const UUID_PATH_RE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const TOTAL_RE = /Showing\s+\d+\s+of\s+(\d+)/i;

export interface SkimaListItem {
  externalId: string;
  jobTitle: string;
  jobUrl: string;
  location: string | null;
  isRemote: boolean;
}

export interface SkimaListingPage {
  items: SkimaListItem[];
  /** Total job count from the "Showing X of N" chrome, if parseable. */
  total: number | null;
}

/** Listing URL for page N (1-based). Page 1 is the bare board URL. */
export function skimaPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(page));
  return u.toString();
}

/** Parse one listing page: emit one item per UUID-path anchor that carries visible text (the Apply-button anchor for the same uuid is text-less); chips are `span.break-all` texts in the closest `.w-full` wrapper. */
export function parseSkimaListingHtml(html: string, baseUrl: string): SkimaListingPage {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const items: SkimaListItem[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href") ?? "";
    const rawId = matchGroup(UUID_PATH_RE, href);
    if (rawId === null) return;
    const externalId = rawId.toLowerCase();
    const jobTitle = collapseWs($a.text());
    if (!jobTitle || seen.has(externalId)) return;

    const chips = $a
      .closest(".w-full")
      .find("span.break-all")
      .map((_i, s) => collapseWs($(s).text()))
      .get()
      .filter(Boolean);
    // Chips are [location, workMode, jobType]; workMode says Remote/In Office.
    const location = chips[0] ?? null;
    const isRemote =
      chips.some((c) => REMOTE_RE.test(c)) || (location !== null && REMOTE_RE.test(location));

    seen.add(externalId);
    items.push({
      externalId,
      jobTitle,
      jobUrl: `${origin}/${externalId}`,
      location,
      isRemote,
    });
  });

  const totalMatch = $.root().text().match(TOTAL_RE);
  const total = totalMatch ? Number(totalMatch[1]) : null;

  return { items, total };
}

export function normalizeSkimaItem(company: AdapterCompany, item: SkimaListItem): NormalizedPosting {
  return {
    provider: "skima",
    externalId: item.externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: item.jobTitle,
    jobUrl: item.jobUrl,
    location: item.location,
    isRemote: item.isRemote,
    jdText: "",
    postedAt: null,
  };
}

export function extractSkimaJd(html: string): string {
  const $ = cheerio.load(html);
  const panel = $("div.job-description-panel").first();
  if (panel.length > 0) return htmlToText(panel.html() ?? "");
  // Theme fallback: the <h1> title's enclosing main content block.
  const main = $("main").first();
  return htmlToText(main.length > 0 ? (main.html() ?? "") : html);
}

export const skimaAdapter: AtsAdapter = {
  provider: "skima",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const baseUrl = tenantOrigin(company);
    return paginate<NormalizedPosting>({
      provider: "skima",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      // Pages are disjoint, so termination is the "total" chrome or a zero-item page - not a short page.
      shortPageEndsPagination: false,
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(skimaPageUrl(baseUrl, page + 1), { provider: "skima" });
        const parsed = parseSkimaListingHtml(html, baseUrl);
        return { items: parsed.items.map((item) => normalizeSkimaItem(company, item)), total: parsed.total };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "skima" });
    return extractSkimaJd(html);
  },
};
