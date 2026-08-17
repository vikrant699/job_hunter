// src/ats/avature.ts — Avature career portals, white-labeled per client on a custom host (jobs.lenovo.com, jobs.siemens.com).
// List: GET <host>/<locale>/<portal>/SearchJobs, server-rendered HTML, no auth. Select fields by class within
// `article.article--result` (subtitle markup is skin-dependent: plain spans on some tenants, .list-item-* blocks on others).
// Pagination follows the page's own "Next" link verbatim (its offset param name differs per tenant and is ignored if we
// override it); stop on no Next link or zero postings (a past-the-end page can render a stale placeholder with a bogus Next).
// JD: GET .../JobDetail/[<slug>/]<id> -> full HTML in `.section__content`.
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml, atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination, dateToIso, collapseWs } from "./shared.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

const MAX_PAGES = 5000; // safety cap in case a tenant's Next link never disappears (loops back on itself, etc.)

// Avature stamps an avature.* meta namespace into every portal page and serves chrome/error pages from /jscore/;
// either is proof the response came from the engine (see assertAvatureBoardServed).
const AVATURE_PORTAL_META_RE = /name="avature\.[a-z]/i;
const AVATURE_ASSET_RE = /\/jscore\//;

/** Whether this response was rendered by Avature at all. */
export function avatureEngineServed(html: string): boolean {
  return AVATURE_PORTAL_META_RE.test(html) || AVATURE_ASSET_RE.test(html);
}

// Page-1-only: zero postings AND no Avature markup means the host stopped serving the portal (dead, not empty);
// a WAF challenge page is checked first so an edge block is reported as infrastructure, not charged to the row.
export function assertAvatureBoardServed(html: string, url: string): void {
  if (avatureEngineServed(html)) return;
  assertNotEdgeChallenge("avature", url, html);

  throw new Error(
    `avature: portal no longer served — ${url} returned a page with no job articles and none of ` +
      `Avature's own portal markup, so it is not an Avature portal and the board is dead rather ` +
      `than empty.`,
  );
}

/** Accepts either the portal root or the SearchJobs URL itself - idempotent either way. */
export function avatureSearchUrl(company: AdapterCompany): string {
  const base = company.tenantUrl ?? company.careersUrl;
  const u = new URL(base);
  // Optional server-side country filter (raw query suffix, e.g. "42386[]=812053"); field/option ids are
  // tenant-specific and the engine's own Next links carry the filter through every page.
  const filter = company.apiMeta?.countryFilter;
  const suffix = filter !== undefined && filter !== "" ? `?${filter}` : "";
  if (/\/SearchJobs\/?$/i.test(u.pathname)) {
    u.search = "";
    u.hash = "";
    return `${u.toString()}${suffix}`;
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}/SearchJobs${suffix}`;
}

/** reqId (+ optional slug) from a "JobDetail/[<slug>/]<id>" href; id is always the last path segment. */
export function parseJobDetailHref(href: string): { slug: string | null; id: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const m = path.match(/\/JobDetail\/(?:([^/]+)\/)?([^/]+)\/?$/i);
  if (!m?.[2]) return null;
  return { slug: m[1] ?? null, id: m[2] };
}

/** `.paginationNextLink` sits on the <a> itself on some skins, wraps one on others - resolve to the <a> either way. */
export function parseAvatureNextHref(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const $next = $(".paginationNextLink").first();
  if (!$next.length) return null;
  const $a = $next.is("a") ? $next : $next.find("a").first();
  const href = $a.attr("href");
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/** First subtitle span text that isn't a "Req #:" / "Posted" / "Job ID:" label. */
function pickLocationFromSpans(spanTexts: string[]): string | null {
  for (const t of spanTexts) {
    if (!t || /^(req\s*#|posted\b|job\s*id)/i.test(t)) continue;
    return t;
  }
  return null;
}

/** Subtitle span text matching "Posted <date>" / "Posted since <date>". */
function pickPostedFromSpans(spanTexts: string[]): string | null {
  for (const t of spanTexts) {
    const m = t.match(/^posted\s*(?:since)?\s*:?\s*(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Parse one SearchJobs page: its postings and the absolute Next-page URL (if any). */
export function parseAvatureSearch(
  html: string,
  baseUrl: string,
  company: AdapterCompany,
): { postings: NormalizedPosting[]; nextHref: string | null } {
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];

  $("article.article--result").each((_, art) => {
    const $art = $(art);
    const $titleLink = $art.find(".article__header__text__title a").first();
    const href = $titleLink.attr("href");
    const title = collapseWs($titleLink.text());
    // The stale "No jobs found" placeholder has no <a> in its title heading, so href/title are both empty here.
    if (!href || !title) return;

    const parsed = parseJobDetailHref(href);
    if (!parsed) return;

    let jobUrl: string;
    try {
      jobUrl = new URL(href, baseUrl).toString();
    } catch {
      return;
    }

    const $subtitle = $art.find(".article__header__text__subtitle").first();
    const spanTexts: string[] = [];
    $subtitle.find("span").each((_i, el) => {
      spanTexts.push(collapseWs($(el).text()));
    });

    const $loc = $subtitle.find(".list-item-location").first();
    let location: string | null;
    if ($loc.length) {
      const parts: string[] = [];
      $loc.find(".list-item-jobCity, .list-item-jobState, .list-item-jobCountry").each((_i, el) => {
        const t = collapseWs($(el).text());
        if (t) parts.push(t);
      });
      location = parts.length ? parts.join(", ") : collapseWs($loc.text()) || null;
    } else {
      location = pickLocationFromSpans(spanTexts);
    }

    const postedRaw = pickPostedFromSpans(spanTexts);

    postings.push({
      provider: "avature",
      externalId: parsed.id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: "",
      postedAt: dateToIso(postedRaw),
    });
  });

  return { postings, nextHref: parseAvatureNextHref(html, baseUrl) };
}

/** Prefers `section.section--description .section__content`; a bare `.section__content` first-match can grab the
 *  metadata sidebar instead on some skins. Falls back to it only when the description section class is absent. */
export function parseAvatureJd(html: string): string {
  const $ = cheerio.load(html);
  const described = $("section.section--description .section__content").first();
  const el = described.length ? described : $(".section__content").first();
  if (!el.length) return "";
  const inner = el.html();
  return inner ? htmlToText(inner) : collapseWs(el.text());
}

export const avatureAdapter: AtsAdapter = {
  provider: "avature",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const out: NormalizedPosting[] = [];
    let url: string | null = avatureSearchUrl(company);
    let page = 0;
    let hitCap = false;

    while (url) {
      // Checked before fetching another page, so this is the only path that sets hitCap.
      if (page >= MAX_PAGES) {
        hitCap = true;
        break;
      }
      const { html, finalUrl } = await atsFetchHtml(url, { provider: "avature" });
      const { postings, nextHref } = parseAvatureSearch(html, finalUrl, company);
      // A past-the-end page can render a stale placeholder that still carries a (wrong) Next link - stop regardless.
      if (postings.length === 0) {
        if (page === 0) assertAvatureBoardServed(html, finalUrl);
        break;
      }

      out.push(...postings);
      page++;
      if (!nextHref) break;

      warnDeepPagination("avature", company.slug, page, out.length);
      await sleep(INTER_PAGE_DELAY_MS);
      url = nextHref;
    }

    if (hitCap) {
      logger.warn(
        { slug: company.slug, maxPages: MAX_PAGES },
        "avature pagination hit the runaway cap - board may be truncated"
      );
    }

    return out;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "avature" });
    return parseAvatureJd(html);
  },
};
