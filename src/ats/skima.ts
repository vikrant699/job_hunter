// List: GET <careersUrl>?page=N (1-based); cards link `/<uuid>` (a text-less Apply anchor repeats each uuid; keep the one with text). Pages are disjoint; stop at the "Showing X of N" total or a zero-item page. JD: div.job-description-panel on /<uuid>.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, tenantOrigin, collapseWs } from "./shared.js";
import { matchGroup } from "../util/regex.js";

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
  total: number | null;
}

export function skimaPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(page));
  return u.toString();
}

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
