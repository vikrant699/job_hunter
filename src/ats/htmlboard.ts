// src/ats/htmlboard.ts — generic selector-driven adapter for bespoke careers
// pages that fully server-render their job list as plain HTML (no JS, no
// auth). One adapter, many single-company boards: the per-company CSS
// selectors live in apiMeta (all values strings, per the apiMeta contract):
//
//   listUrl          optional — board URL; defaults to tenantUrl/careersUrl.
//   itemSelector     REQUIRED — one match per job card/row/block.
//   titleSelector    optional — title element inside the item (default: the
//                    item's first <a>, else the item itself).
//   linkSelector     optional — anchor inside the item for the job detail
//                    link (default "a"); resolved against the list URL.
//   locationSelector optional — location element inside the item.
//   locationRegex    optional — regex with ONE capture group, run over the
//                    item's (or detail page's) plain text when there is no
//                    dedicated location element (e.g. "Location\\s*:?-?\\s*([^\\n|]+)").
//   fixedLocation    optional — hardcoded location when the board states it
//                    only once for all jobs (single-office companies).
//   jdSelector       optional — JD element INSIDE the item (single-page
//                    boards that inline the full JD under each job block).
//   detailJdSelector optional — JD element on the linked detail page,
//                    fetched lazily via fetchJd. If neither jd selector is
//                    set, fetchJd falls back to the detail page's <main>/<body>.
//   locationAttr     optional — read the location from this ATTRIBUTE of the
//                    item element (e.g. "data-location") instead of a child's
//                    text. Checked before locationSelector.
//   pageParam        optional — query-param name for 1-based pagination
//                    (e.g. "page"); page 1 is the bare listUrl. Paging stops
//                    at the first page that adds no new items.
//   titleRegex       optional — regex with ONE capture group applied to the
//                    raw title text (e.g. "^Job Function:\\s*(.+)$"); on no
//                    match the raw text is kept.
//   excludeTitleRegex optional — items whose title matches are skipped
//                    (section headings on hand-authored pages).
//   idAttr           optional — item attribute holding a stable external id
//                    (e.g. "id" on boards whose card id is the job path).
//   itemUrlAttr      optional — item attribute holding the RELATIVE detail
//                    path (e.g. Frappe boards store it in the card's id).
//   noItemLinks      optional ("true") — ignore anchors inside items entirely:
//                    boards whose only links are a SHARED apply form/mailto
//                    would otherwise collapse every item into one externalId.
//
// externalId: the detail link's path when present (stable), else a slug of
// the title — fine for the small static boards this adapter targets.
// Pagination: deliberately none — every board converted onto this adapter
// renders its whole list in one response (verified per tenant before
// flipping). A board that grows a pager needs its own adapter or an upgrade
// here, not silent truncation.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination } from "./shared.js";

// Runaway backstop for pageParam boards whose zero-new-items stop misfires.
const MAX_PAGES = 200;

function pageUrl(cfg: HtmlBoardConfig, page: number): string {
  if (!cfg.pageParam || page <= 1) return cfg.listUrl;
  const u = new URL(cfg.listUrl);
  u.searchParams.set(cfg.pageParam, String(page));
  return u.toString();
}

export interface HtmlBoardConfig {
  listUrl: string;
  itemSelector: string;
  titleSelector: string | null;
  linkSelector: string | null;
  locationSelector: string | null;
  locationAttr: string | null;
  locationRegex: RegExp | null;
  fixedLocation: string | null;
  jdSelector: string | null;
  detailJdSelector: string | null;
  pageParam: string | null;
  titleRegex: RegExp | null;
  excludeTitleRegex: RegExp | null;
  idAttr: string | null;
  itemUrlAttr: string | null;
  noItemLinks: boolean;
}

export function htmlBoardConfig(company: AdapterCompany): HtmlBoardConfig {
  const meta = company.apiMeta ?? {};
  const itemSelector = meta.itemSelector;
  if (!itemSelector) {
    throw new Error(`htmlboard requires apiMeta.itemSelector for ${company.slug}`);
  }
  const listUrl = meta.listUrl ?? company.tenantUrl ?? company.careersUrl;
  return {
    listUrl,
    itemSelector,
    titleSelector: meta.titleSelector ?? null,
    linkSelector: meta.linkSelector ?? null,
    locationSelector: meta.locationSelector ?? null,
    locationAttr: meta.locationAttr ?? null,
    locationRegex: meta.locationRegex ? new RegExp(meta.locationRegex, "i") : null,
    fixedLocation: meta.fixedLocation ?? null,
    jdSelector: meta.jdSelector ?? null,
    detailJdSelector: meta.detailJdSelector ?? null,
    pageParam: meta.pageParam ?? null,
    titleRegex: meta.titleRegex ? new RegExp(meta.titleRegex, "i") : null,
    excludeTitleRegex: meta.excludeTitleRegex ? new RegExp(meta.excludeTitleRegex, "i") : null,
    idAttr: meta.idAttr ?? null,
    itemUrlAttr: meta.itemUrlAttr ?? null,
    noItemLinks: meta.noItemLinks === "true",
  };
}

function cleanText($el: { text(): string }): string {
  return $el.text().replace(/\s+/g, " ").trim();
}

/** Stable id for a posting: the detail link's path+query when it actually
 *  points somewhere (not back at the list page itself — accordion boards use
 *  identical "#"/mailto anchors on every item, which would collapse all items
 *  into one id), else a slug of the title (deduped by caller). */
export function htmlBoardExternalId(jobUrl: string | null, title: string, listUrl?: string): string {
  if (jobUrl && !jobUrl.startsWith("mailto:")) {
    try {
      const u = new URL(jobUrl);
      const key = (u.pathname + u.search).replace(/\/+$/, "");
      let listKey: string | null = null;
      if (listUrl) {
        try {
          const l = new URL(listUrl);
          listKey = (l.pathname + l.search).replace(/\/+$/, "");
        } catch { /* ignore */ }
      }
      if (key && key !== listKey) return key;
    } catch {
      /* fall through to title slug */
    }
  }
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface HtmlBoardItem {
  externalId: string;
  jobTitle: string;
  jobUrl: string | null;
  location: string | null;
  jdText: string;
}

export function parseHtmlBoardListing(html: string, cfg: HtmlBoardConfig): HtmlBoardItem[] {
  const $ = cheerio.load(html);
  const items: HtmlBoardItem[] = [];
  const seen = new Set<string>();

  $(cfg.itemSelector).each((_, el) => {
    const $item = $(el);

    const $title = cfg.titleSelector
      ? $item.find(cfg.titleSelector).first()
      : $item.is("a")
        ? $item
        : $item.find("a").first().length > 0
          ? $item.find("a").first()
          : $item;
    let jobTitle = cleanText($title);
    if (!jobTitle) return;
    if (cfg.excludeTitleRegex?.test(jobTitle)) return;
    if (cfg.titleRegex) {
      const m = jobTitle.match(cfg.titleRegex);
      if (m?.[1]) jobTitle = m[1].trim();
    }

    const $link = cfg.linkSelector
      ? $item.find(cfg.linkSelector).first()
      : $item.is("a")
        ? $item
        : $item.find("a[href]").first();
    const href = cfg.noItemLinks
      ? null
      : ((cfg.itemUrlAttr ? $item.attr(cfg.itemUrlAttr) : null) ?? $link.attr("href") ?? null);
    let jobUrl: string | null = null;
    if (href) {
      try {
        jobUrl = new URL(href, cfg.listUrl).toString();
      } catch {
        jobUrl = null;
      }
    }

    let location: string | null = null;
    if (cfg.locationAttr) {
      location = $item.attr(cfg.locationAttr)?.trim() || null;
    }
    if (!location && cfg.locationSelector) {
      const t = cleanText($item.find(cfg.locationSelector).first());
      location = t || null;
    }
    if (!location && cfg.locationRegex) {
      const m = htmlToText($item.html() ?? "").match(cfg.locationRegex);
      location = m?.[1]?.trim() || null;
    }
    if (!location && cfg.fixedLocation) location = cfg.fixedLocation;

    const jdText = cfg.jdSelector ? htmlToText($item.find(cfg.jdSelector).first().html() ?? "") : "";

    const externalId =
      (cfg.idAttr ? $item.attr(cfg.idAttr)?.trim() : null) ??
      htmlBoardExternalId(jobUrl, jobTitle, cfg.listUrl);
    if (!externalId || seen.has(externalId)) return;
    seen.add(externalId);

    items.push({ externalId, jobTitle, jobUrl, location, jdText });
  });

  return items;
}

export function extractHtmlBoardJd(html: string, cfg: HtmlBoardConfig): string {
  const $ = cheerio.load(html);
  if (cfg.detailJdSelector) {
    const el = $(cfg.detailJdSelector).first();
    if (el.length > 0) return htmlToText(el.html() ?? "");
  }
  const main = $("main").first();
  if (main.length > 0) return htmlToText(main.html() ?? "");
  return htmlToText($("body").html() ?? "");
}

export const htmlboardAdapter: AtsAdapter = {
  provider: "htmlboard",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const cfg = htmlBoardConfig(company);
    const items: HtmlBoardItem[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = pageUrl(cfg, page);
      const html = await atsFetchText(url, { provider: "htmlboard" });
      const pageItems = parseHtmlBoardListing(html, cfg);
      const before = items.length;
      for (const item of pageItems) {
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }
      // Single-page boards, or a page that added nothing new, end the loop.
      if (!cfg.pageParam || items.length === before) break;
      warnDeepPagination("htmlboard", company.slug, page, items.length);
      await sleep(INTER_PAGE_DELAY_MS);
    }

    return items.map((item) => ({
      provider: "htmlboard",
      externalId: item.externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: item.jobTitle,
      jobUrl: item.jobUrl ?? cfg.listUrl,
      location: item.location,
      isRemote: item.location ? REMOTE_RE.test(item.location) : false,
      jdText: item.jdText,
      postedAt: null,
    }));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const cfg = htmlBoardConfig(company);
    // Inline-JD boards never get here (jdText already set); detail boards do.
    if (!posting.jobUrl || posting.jobUrl === cfg.listUrl) return posting.jdText;
    const html = await atsFetchText(posting.jobUrl, { provider: "htmlboard" });
    const jd = extractHtmlBoardJd(html, cfg);
    // Apply the location regex against the detail text too, as a late assist
    // for boards whose list omits location (caller merges via posting object).
    return jd;
  },
};
