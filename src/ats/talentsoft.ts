// List: same URL with `mode=list` forced (other modes render different markups), paged via `&page=N` until the `.ts-ol-pagination__title.resultat .gras` total. Detail: elements between `<h2 class="JobDescription">` and the next `<h2>` under `#contenu-ficheoffre`.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate, collapseWs } from "./shared.js";

const NOMINAL_PAGE_SIZE = 20;

const ID_RE = /_(\d+)\.aspx(?:[?#]|$)/i;
const TOTAL_RE = /(\d+)/;

export interface TalentsoftListItem {
  externalId: string;
  jobTitle: string;
  jobUrl: string;
  location: string | null;
}

export interface TalentsoftListingPage {
  items: TalentsoftListItem[];
  total: number | null;
}

export function talentsoftListingUrl(company: AdapterCompany): string {
  const raw = company.tenantUrl ?? company.careersUrl;
  const u = new URL(raw);
  u.searchParams.set("mode", "list");
  return u.toString();
}

export function talentsoftPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(page));
  return u.toString();
}

export function talentsoftIdFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0] ?? "";
  const m = path.match(ID_RE);
  return m ? (m[1] ?? null) : null;
}

export function talentsoftLocationFromDescItems(descItems: string[]): string | null {
  const items = descItems.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0] ?? null;
  const country = items[items.length - 2] ?? "";
  const city = items[items.length - 1] ?? "";
  return `${city}, ${country}`;
}

export function parseTalentsoftListingHtml(html: string, baseUrl: string): TalentsoftListingPage {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const items: TalentsoftListItem[] = [];
  const seen = new Set<string>();

  $(".ts-offer-list-item").each((_, el) => {
    const $el = $(el);
    const $link = $el.find(".ts-offer-list-item__title-link").first();
    const href = $link.attr("href");
    const jobTitle = collapseWs($link.text());
    if (!href || !jobTitle) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, origin).toString();
    } catch {
      return;
    }

    const externalId = talentsoftIdFromUrl(jobUrl);
    if (!externalId || seen.has(externalId)) return;

    const descItems = $el
      .find(".ts-offer-list-item__description li")
      .map((_i, li) => $(li).text())
      .get();
    const location = talentsoftLocationFromDescItems(descItems);

    seen.add(externalId);
    items.push({ externalId, jobTitle, jobUrl, location });
  });

  const totalText = $(".ts-ol-pagination__title.resultat .gras").first().text();
  const totalMatch = totalText.match(TOTAL_RE);
  const total = totalMatch ? Number(totalMatch[1]) : null;

  return { items, total };
}

export function normalizeTalentsoftItem(company: AdapterCompany, item: TalentsoftListItem): NormalizedPosting {
  return {
    provider: "talentsoft",
    externalId: item.externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: item.jobTitle,
    jobUrl: item.jobUrl,
    location: item.location,
    isRemote: item.location ? REMOTE_RE.test(item.location) : false,
    jdText: "",
    postedAt: null,
  };
}

export function extractTalentsoftJdHtml(html: string): string {
  const $ = cheerio.load(html);
  const heading = $("h2.JobDescription").first();
  if (heading.length === 0) {
    const container = $("#contenu-ficheoffre, .ts-offer-page__content-details").first();
    return htmlToText(container.length > 0 ? (container.html() ?? "") : html);
  }

  const parts: string[] = [];
  heading.nextUntil("h2").each((_i, el) => {
    parts.push($.html(el));
  });
  return htmlToText(parts.join("\n"));
}

export const talentsoftAdapter: AtsAdapter = {
  provider: "talentsoft",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const baseUrl = talentsoftListingUrl(company);
    return paginate<NormalizedPosting>({
      provider: "talentsoft",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      shortPageEndsPagination: false,
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(talentsoftPageUrl(baseUrl, page + 1), { provider: "talentsoft" });
        const parsed = parseTalentsoftListingHtml(html, baseUrl);
        return { items: parsed.items.map((item) => normalizeTalentsoftItem(company, item)), total: parsed.total };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "talentsoft" });
    return extractTalentsoftJdHtml(html);
  },
};
