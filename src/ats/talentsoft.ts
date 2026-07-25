// src/ats/talentsoft.ts — TalentSoft (Cegid), a shared French HR/recruiting
// SaaS. Career sites (e.g. jobs.ca-cib.com for Crédit Agricole CIB) fully
// server-render their job listings and detail pages as plain HTML — no JS
// needed, no auth.
//
//   list: GET <listing-url> where <listing-url> is the tenant's stored
//         careersUrl/tenantUrl, e.g.
//         https://jobs.ca-cib.com/pages/offre/listeoffre.aspx?mode=list&lcid=2057&facet_Country=96
//         The `lcid` (locale) and `facet_Country` (country filter) query
//         params live entirely in that stored URL — never hardcoded here,
//         since they're tenant-specific registry configuration. We DO force
//         `mode=list` on every request (overwriting whatever is stored):
//         TalentSoft renders the same data as three different markups
//         depending on `mode` (list / card / map), and only `mode=list`
//         produces the `.ts-offer-list-item` shape this adapter parses;
//         verified live that a request without it (or with a stale `page=N`
//         from a previous list view) can fall back to a `.ts-offer-card`
//         layout instead.
//
//         Each `<li class="ts-offer-list-item ...">` holds the title/link
//         (`.ts-offer-list-item__title-link`, href `/job/job-<slug>_<id>.aspx`)
//         and a 3-item description list
//         (`.ts-offer-list-item__description li`): contract type, country,
//         city — in that order, verified live and consistent across the
//         full 388-job unfiltered board and the 10-job India-filtered one.
//
//         Pagination: TalentSoft appends `&page=N` (1-based; page 1 is the
//         bare URL) to the SAME listing URL. The result count lives in
//         `.ts-ol-pagination__title.resultat .gras` (e.g. "388 vacancy(s)")
//         — a CSS-class selector, not the localized page `<title>` text, so
//         this keeps working on non-English tenants. We page until the
//         running total reaches that count, AND independently stop on the
//         first zero-item page (defensive backstop in case the count is
//         missing/wrong on some tenant) — completeness over trusting either
//         signal alone.
//
//   jd:   GET the job detail page. The JD body is every element between
//         `<h2 class="JobDescription">` and the next `<h2>` sibling (both
//         live as direct children of `#contenu-ficheoffre`) — this
//         deliberately excludes the "General information" block above it
//         (company-boilerplate entity description, reference, update date)
//         and the "Position location"/"Candidate criteria" sections below
//         it, verified live on a Crédit Agricole CIB posting.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination } from "./shared.js";

// Runaway backstop for when the `.resultat .gras` count is missing/unparseable
// and pagination relies solely on the zero-item-page stop — high enough that
// no real board is ever truncated.
const MAX_PAGES = 5000;

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
  /** Total vacancy count reported by the listing chrome, if parseable. */
  total: number | null;
}

/**
 * Base listing URL for a tenant: the stored tenantUrl if set, else the
 * stored careersUrl — either way carrying whatever lcid/facet_Country the
 * registry configured. `mode=list` is always forced on top (see file header).
 */
export function talentsoftListingUrl(company: AdapterCompany): string {
  const raw = company.tenantUrl ?? company.careersUrl;
  const u = new URL(raw);
  u.searchParams.set("mode", "list");
  return u.toString();
}

/** The same listing URL for page N (1-based). Page 1 is the bare URL, unmodified. */
export function talentsoftPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl;
  const u = new URL(baseUrl);
  u.searchParams.set("page", String(page));
  return u.toString();
}

/** externalId from a job detail URL: the trailing numeric id before `.aspx`,
 *  e.g. ".../job-caspl-head-of-trade-finance_114086.aspx" -> "114086". Null
 *  if the URL doesn't match that shape (never a fallback id to collide on
 *  the dedup key). */
export function talentsoftIdFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0] ?? "";
  const m = path.match(ID_RE);
  return m ? (m[1] ?? null) : null;
}

/**
 * Build a location string from a listing card's description `<li>` texts
 * (contract type, country, city — in that order, see file header). Takes
 * the last two entries as "<city>, <country>"; degrades gracefully to
 * whatever is present for the rare tenant that renders fewer/more fields.
 */
export function talentsoftLocationFromDescItems(descItems: string[]): string | null {
  const items = descItems.map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0] ?? null;
  const country = items[items.length - 2] ?? "";
  const city = items[items.length - 1] ?? "";
  return `${city}, ${country}`;
}

/**
 * Parse one listing page's job cards + the reported total vacancy count.
 * Pure — unit tested directly. Dedups by externalId within the page as a
 * defensive backstop.
 */
export function parseTalentsoftListingHtml(html: string, baseUrl: string): TalentsoftListingPage {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const items: TalentsoftListItem[] = [];
  const seen = new Set<string>();

  $(".ts-offer-list-item").each((_, el) => {
    const $el = $(el);
    const $link = $el.find(".ts-offer-list-item__title-link").first();
    const href = $link.attr("href");
    const jobTitle = $link.text().replace(/\s+/g, " ").trim();
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

// ---------------------------------------------------------------------------
// JD extraction — see file header for the section boundary rationale.
// ---------------------------------------------------------------------------

/** Extract the JD body's plain text from a job detail page. */
export function extractTalentsoftJdHtml(html: string): string {
  const $ = cheerio.load(html);
  const heading = $("h2.JobDescription").first();
  if (heading.length === 0) {
    // Fallback: whole details container (theme variant without the expected heading).
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
    const out: NormalizedPosting[] = [];
    const seenIds = new Set<string>();
    let total: number | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const html = await atsFetchText(talentsoftPageUrl(baseUrl, page), { provider: "talentsoft" });
      const parsed = parseTalentsoftListingHtml(html, baseUrl);
      if (total === null) total = parsed.total;

      for (const item of parsed.items) {
        if (seenIds.has(item.externalId)) continue;
        seenIds.add(item.externalId);
        out.push(normalizeTalentsoftItem(company, item));
      }

      if (parsed.items.length === 0) break; // defensive: holds even if `total` lied
      if (total !== null && out.length >= total) break;

      warnDeepPagination("talentsoft", company.slug, page, out.length);
      await sleep(INTER_PAGE_DELAY_MS);
    }

    return out;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "talentsoft" });
    return extractTalentsoftJdHtml(html);
  },
};
