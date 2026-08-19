// src/ats/htmlboard.ts — generic selector-driven adapter for bespoke, server-rendered HTML careers pages
// (no JS/auth); per-company CSS selectors live in apiMeta (see HtmlBoardConfig for fields).
// boardSelector (distinct from itemSelector) is positive proof the board rendered, so a zero-item page
// without it fails loud instead of reporting an empty board (see assertHtmlBoardRendered); noItemLinks
// exists for boards whose only links are a shared apply form/mailto. Pagination: none by default (every
// converted board renders its whole list in one response); pageParam boards page until nothing new is added.
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, collapseWs } from "./shared.js";
import { kebabCase } from "../util/slug.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

// Runaway backstop for pageParam boards whose zero-new-items stop misfires.
const MAX_PAGES = 200;
// No pageSize is evidenced anywhere (arbitrary hand-authored HTML boards);
// termination for pageParam boards is "this page added nothing new" (see
// listPostings), not a page-length comparison, so this is informational only.
const NOMINAL_PAGE_SIZE = 20;

function pageUrl(cfg: HtmlBoardConfig, page: number): string {
  if (!cfg.pageParam || page <= 1) return cfg.listUrl;
  const u = new URL(cfg.listUrl);
  u.searchParams.set(cfg.pageParam, String(page));
  return u.toString();
}

export interface HtmlBoardConfig {
  listUrl: string;
  itemSelector: string;
  boardSelector: string | null;
  titleSelector: string | null;
  linkSelector: string | null;
  locationSelector: string | null;
  locationAttr: string | null;
  locationRegex: RegExp | null;
  fixedLocation: string | null;
  jdSelector: string | null;
  detailJdSelector: string | null;
  /** Regex w/ ONE capture group over the raw detail-page source (before any selector), for JDs embedded
   *  in script payloads (e.g. RSC data); captured group is JSON-unescaped before the HTML strip. */
  detailJdRegex: string | null;
  pageParam: string | null;
  titleRegex: RegExp | null;
  excludeTitleRegex: RegExp | null;
  idAttr: string | null;
  itemUrlAttr: string | null;
  noItemLinks: boolean;
  /** Two-level boards (GitBook-style): listUrl page links to section pages; items live on the sections. */
  sectionSelector: string | null;
  /** Appended to jobUrl when fetching the JD (GitBook serves clean markdown at <page>.md). */
  jdUrlSuffix: string | null;
}

export function htmlBoardConfig(company: AdapterCompany): HtmlBoardConfig {
  const meta = company.apiMeta ?? {};
  const itemSelector = meta.itemSelector;
  if (!itemSelector) {
    throw new Error(`htmlboard requires apiMeta.itemSelector for ${company.slug}`);
  }
  if (meta.sectionSelector && meta.pageParam) {
    throw new Error(`htmlboard: sectionSelector and pageParam are mutually exclusive (${company.slug})`);
  }
  const listUrl = meta.listUrl ?? company.tenantUrl ?? company.careersUrl;
  return {
    listUrl,
    itemSelector,
    boardSelector: meta.boardSelector ?? null,
    titleSelector: meta.titleSelector ?? null,
    linkSelector: meta.linkSelector ?? null,
    locationSelector: meta.locationSelector ?? null,
    locationAttr: meta.locationAttr ?? null,
    locationRegex: meta.locationRegex ? new RegExp(meta.locationRegex, "i") : null,
    fixedLocation: meta.fixedLocation ?? null,
    jdSelector: meta.jdSelector ?? null,
    detailJdSelector: meta.detailJdSelector ?? null,
    detailJdRegex: meta.detailJdRegex ?? null,
    pageParam: meta.pageParam ?? null,
    titleRegex: meta.titleRegex ? new RegExp(meta.titleRegex, "i") : null,
    excludeTitleRegex: meta.excludeTitleRegex ? new RegExp(meta.excludeTitleRegex, "i") : null,
    idAttr: meta.idAttr ?? null,
    itemUrlAttr: meta.itemUrlAttr ?? null,
    noItemLinks: meta.noItemLinks === "true",
    sectionSelector: meta.sectionSelector ?? null,
    jdUrlSuffix: meta.jdUrlSuffix ?? null,
  };
}

/** Unique section-page URLs from the root page, resolved against listUrl. */
export function sectionUrls(rootHtml: string, cfg: HtmlBoardConfig): string[] {
  if (!cfg.sectionSelector) return [];
  const $ = cheerio.load(rootHtml);
  const urls = new Set<string>();
  $(cfg.sectionSelector).each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      urls.add(new URL(href, cfg.listUrl).toString());
    } catch {
      /* skip malformed hrefs */
    }
  });
  return [...urls];
}

function cleanText($el: { text(): string }): string {
  return collapseWs($el.text());
}

/** Stable id: the detail link's path+query when it doesn't just point back at the list page (accordion
 *  boards reuse identical "#"/mailto anchors on every item), else a slug of the title (deduped by caller). */
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
  return kebabCase(title);
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

    // Join EVERY jdSelector match: single-page boards spread the JD across sibling widget blocks inside one item.
    const jdText = cfg.jdSelector
      ? htmlToText(
          $item
            .find(cfg.jdSelector)
            .map((_, el) => $(el).html() ?? "")
            .get()
            .join("\n"),
        )
      : "";

    const externalId =
      (cfg.idAttr ? $item.attr(cfg.idAttr)?.trim() : null) ??
      htmlBoardExternalId(jobUrl, jobTitle, cfg.listUrl);
    if (!externalId || seen.has(externalId)) return;
    seen.add(externalId);

    items.push({ externalId, jobTitle, jobUrl, location, jdText });
  });

  return items;
}

/** Fail a zero-item page that can't prove it's even the board (parked domain, redesign, WAF page at HTTP
 *  200) rather than reporting a healthy empty board. boardSelector is opt-in positive evidence the board
 *  rendered; only consulted once items come up empty. An edge-challenge page is checked first regardless
 *  of boardSelector, since that's infrastructure-shaped, not company-shaped. */
export function assertHtmlBoardRendered(html: string, cfg: HtmlBoardConfig, itemCount: number, slug: string): void {
  if (itemCount > 0) return;
  assertNotEdgeChallenge("htmlboard", cfg.listUrl, html);
  if (!cfg.boardSelector) return;
  // Second cheerio parse, but only ever on a page that came up empty.
  if (cheerio.load(html)(cfg.boardSelector).length > 0) return;
  throw new Error(
    `htmlboard: board did not render at ${cfg.listUrl} for ${slug} — no items, and the configured ` +
      `boardSelector matched nothing either. The page is not this board (parked domain or redesign; ` +
      `a bot-block page is classified separately, as an edge refusal), so it is not an empty board.`,
  );
}

export function extractHtmlBoardJd(html: string, cfg: HtmlBoardConfig): string {
  if (cfg.detailJdRegex !== null) {
    const m = new RegExp(cfg.detailJdRegex, "s").exec(html);
    const captured = m?.[1];
    if (captured !== undefined && captured !== "") {
      // Script-payload JDs arrive as JSON string content: decode the common
      // escapes before stripping tags.
      const decoded = captured
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\(["/nrt\\])/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
      return htmlToText(decoded);
    }
  }
  const $ = cheerio.load(html);
  if (cfg.detailJdSelector) {
    const el = $(cfg.detailJdSelector).first();
    if (el.length > 0) return htmlToText(el.html() ?? "");
  }
  const main = $("main").first();
  if (main.length > 0) return htmlToText(main.html() ?? "");
  return htmlToText($("body").html() ?? "");
}

function htmlBoardItemToPosting(company: AdapterCompany, cfg: HtmlBoardConfig, item: HtmlBoardItem): NormalizedPosting {
  return {
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
  };
}

export const htmlboardAdapter: AtsAdapter = {
  provider: "htmlboard",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const cfg = htmlBoardConfig(company);

    // Section crawl: items live on section pages linked from listUrl, deduped globally.
    if (cfg.sectionSelector) {
      const rootHtml = await atsFetchText(cfg.listUrl, { provider: "htmlboard" });
      const items: HtmlBoardItem[] = [];
      const seen = new Set<string>();
      for (const url of sectionUrls(rootHtml, cfg)) {
        const html = await atsFetchText(url, { provider: "htmlboard" });
        for (const item of parseHtmlBoardListing(html, cfg)) {
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
        }
      }
      assertHtmlBoardRendered(rootHtml, cfg, items.length, company.slug);
      return items.map((item) => htmlBoardItemToPosting(company, cfg, item));
    }

    // No pageParam: the whole list renders in one response, fetched directly (never through paginate())
    // so it can't trip the maxPages cap-exit warning.
    if (!cfg.pageParam) {
      const html = await atsFetchText(cfg.listUrl, { provider: "htmlboard" });
      const items = parseHtmlBoardListing(html, cfg);
      assertHtmlBoardRendered(html, cfg, items.length, company.slug);
      return items.map((item) => htmlBoardItemToPosting(company, cfg, item));
    }

    // pageParam boards have no size/total metric, so termination is "this page added nothing new";
    // paginate()'s dedupeBy is only a passive filter, not a termination signal, so the seen-set is
    // tracked here directly and fetchPage returns only newly-seen items (making the default items.length
    // count naturally 0 on a repeat).
    const seen = new Set<string>();
    const items = await paginate<HtmlBoardItem>({
      provider: "htmlboard",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      shortPageEndsPagination: false,
      maxPages: MAX_PAGES,
      fetchPage: async (_offset, page) => {
        const html = await atsFetchText(pageUrl(cfg, page + 1), { provider: "htmlboard" });
        const parsed = parseHtmlBoardListing(html, cfg);
        // Page 1 only: past the last page a pager may legitimately serve a generic 200, and failing the company for that would be a false alarm.
        if (page === 0) assertHtmlBoardRendered(html, cfg, parsed.length, company.slug);
        const newItems = parsed.filter((item) => {
          if (seen.has(item.externalId)) return false;
          seen.add(item.externalId);
          return true;
        });
        return { items: newItems, total: null };
      },
    });

    return items.map((item) => htmlBoardItemToPosting(company, cfg, item));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const cfg = htmlBoardConfig(company);
    // Inline-JD boards never get here (jdText already set); detail boards do.
    if (!posting.jobUrl || posting.jobUrl === cfg.listUrl) return posting.jdText;
    const jdUrl = cfg.jdUrlSuffix ? posting.jobUrl + cfg.jdUrlSuffix : posting.jobUrl;
    const html = await atsFetchText(jdUrl, { provider: "htmlboard" });
    const jd = extractHtmlBoardJd(html, cfg);
    return jd;
  },
};
