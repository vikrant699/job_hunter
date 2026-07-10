// src/ats/avature.ts — Avature career portals, white-labeled per client on a
// CUSTOM host (e.g. jobs.lenovo.com, jobs.siemens.com). Clean, unauthenticated,
// server-rendered HTML.
//
//   list: GET https://<host>/<locale>/<portal>/SearchJobs
//         -> `<article class="article article--result">` blocks, each with:
//              .article__header__text__title a   title text + JobDetail href
//              .article__header__text__subtitle   location / req id / posted
//                (skin-dependent: some tenants render plain <span> siblings
//                 with a "Req #:"/"Posted" text prefix (Lenovo); others render
//                 a `.list-item-location` (+ jobCity/jobState/jobCountry) and
//                 `.list-item-jobId` block (Siemens) — select by class within
//                 the article, never by column/child position.)
//         Pagination: the page's own "Next" link (`.paginationNextLink`,
//         which is the <a> itself on some skins and wraps an <a> on others)
//         carries the true offset — its query param NAME differs per tenant
//         (jobRecordsPerPage/jobOffset vs folderRecordsPerPage/folderOffset)
//         and overriding it ourselves is ignored server-side, so we always
//         follow the in-page href verbatim until no Next link is found. A
//         page requested past the real last page renders a stale/bogus
//         "No jobs found" placeholder article (no title link) that can still
//         carry a (wrong) Next link back toward the start — we guard against
//         that by also stopping the moment a page yields zero real postings.
//
//   jd:   GET https://<host>/.../JobDetail/<slug>/<id>  (slug segment is
//         OPTIONAL — some tenants link straight to JobDetail/<id>) -> full
//         plain-HTML JD in the single `.section__content` block (title, req
//         metadata, and description all render inside it; grabbing the whole
//         block satisfies "full JD present" even though it isn't JD-only).
import * as cheerio from "cheerio";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchHtml, atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination } from "./shared.js";

// Safety cap on page hops in case a tenant's Next link never disappears
// (loops back on itself, etc.) — pagination normally ends on its own once the
// real last page is reached (no Next link) or a page yields zero postings.
const MAX_PAGES = 300;

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Origin the board is served from — prefers tenant_url when set, else careers_url. */
export function avatureOrigin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/**
 * Build the initial SearchJobs URL from careers_url/tenant_url. Accepts either
 * the portal root (".../en_US/careers") or the SearchJobs URL itself
 * (".../en_US/careers/SearchJobs") — idempotent either way.
 */
export function avatureSearchUrl(company: AdapterCompany): string {
  const base = company.tenantUrl ?? company.careersUrl;
  const u = new URL(base);
  if (/\/SearchJobs\/?$/i.test(u.pathname)) {
    u.search = "";
    u.hash = "";
    return u.toString();
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}/SearchJobs`;
}

/**
 * reqId (+ optional slug) from a "JobDetail/<slug>/<id>" or "JobDetail/<id>"
 * href. The slug segment is optional (Siemens links straight to the numeric
 * id); the id is always the LAST path segment. Null when the shape doesn't
 * match at all.
 */
export function parseJobDetailHref(href: string): { slug: string | null; id: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const m = path.match(/\/JobDetail\/(?:([^/]+)\/)?([^/]+)\/?$/i);
  if (!m?.[2]) return null;
  return { slug: m[1] ?? null, id: m[2] };
}

/**
 * The in-page "Next" link. `.paginationNextLink` sits on the <a> itself on
 * some skins and on a wrapping <li> on others — resolve to the <a> either
 * way. Returns an absolute URL (resolved against `baseUrl`), or null when
 * there is no Next link (i.e. this is the last page).
 */
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

/** Tenant date formats vary ("10-Jul-2026", "Jul 10, 2026"); both parse. */
function parseAvatureDate(s: string | null): string | null {
  if (!s) return null;
  const ms = Date.parse(s.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
    const title = cleanText($titleLink.text());
    // The stale "No jobs found" placeholder renders the title heading with no
    // <a> inside it — href/title are both empty, so it's dropped here.
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
      spanTexts.push(cleanText($(el).text()));
    });

    const $loc = $subtitle.find(".list-item-location").first();
    let location: string | null;
    if ($loc.length) {
      const parts: string[] = [];
      $loc.find(".list-item-jobCity, .list-item-jobState, .list-item-jobCountry").each((_i, el) => {
        const t = cleanText($(el).text());
        if (t) parts.push(t);
      });
      location = parts.length ? parts.join(", ") : cleanText($loc.text()) || null;
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
      postedAt: parseAvatureDate(postedRaw),
    });
  });

  return { postings, nextHref: parseAvatureNextHref(html, baseUrl) };
}

/** Extract the JD body (`.section__content`, first match) as plain text. */
export function parseAvatureJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $(".section__content").first();
  if (!el.length) return "";
  const inner = el.html();
  return inner ? htmlToText(inner) : cleanText(el.text());
}

export const avatureAdapter: AtsAdapter = {
  provider: "avature",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const out: NormalizedPosting[] = [];
    let url: string | null = avatureSearchUrl(company);
    let page = 0;

    while (url && page < MAX_PAGES) {
      const { html, finalUrl } = await atsFetchHtml(url, { provider: "avature" });
      const { postings, nextHref } = parseAvatureSearch(html, finalUrl, company);
      // A page past the real last one can render a stale "No jobs found"
      // placeholder that still carries a (wrong) Next link — stop here
      // regardless of nextHref so that case can never loop.
      if (postings.length === 0) break;

      out.push(...postings);
      page++;
      if (!nextHref) break;

      warnDeepPagination("avature", company.slug, page, out.length);
      await sleep(INTER_PAGE_DELAY_MS);
      url = nextHref;
    }

    return out;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "avature" });
    return parseAvatureJd(html);
  },
};
