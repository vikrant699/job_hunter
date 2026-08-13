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
//         On the FIRST page, zero postings additionally has to be told apart
//         from the host no longer serving an Avature portal at all — see
//         assertAvatureBoardServed.
//
//   jd:   GET https://<host>/.../JobDetail/<slug>/<id>  (slug segment is
//         OPTIONAL — some tenants link straight to JobDetail/<id>) -> full
//         plain-HTML JD in the single `.section__content` block (title, req
//         metadata, and description all render inside it; grabbing the whole
//         block satisfies "full JD present" even though it isn't JD-only).
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchHtml, atsFetchText } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination, dateToIso, collapseWs } from "./shared.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

// Safety cap on page hops in case a tenant's Next link never disappears
// (loops back on itself, etc.) — pagination normally ends on its own once the
// real last page is reached (no Next link) or a page yields zero postings.
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

// Avature stamps its own meta namespace into every portal page it renders
// (avature.portal.id / .urlPath / .lang, avature.wizard.registrars), and serves
// its chrome and error pages out of /jscore/. Either is proof the response came
// from the engine; see assertAvatureBoardServed for why both are accepted.
const AVATURE_PORTAL_META_RE = /name="avature\.[a-z]/i;
const AVATURE_ASSET_RE = /\/jscore\//;

/** Whether this response was rendered by Avature at all. */
export function avatureEngineServed(html: string): boolean {
  return AVATURE_PORTAL_META_RE.test(html) || AVATURE_ASSET_RE.test(html);
}

/**
 * Throw when a first page that yielded no postings did not come from Avature.
 *
 * Eight of nine live rows sit on the company's OWN host (jobs.lenovo.com,
 * careers.tesco.com, jobs.siemens.com, ...), so the failure to catch is such a
 * host quietly ceasing to serve its Avature portal while still answering 200 —
 * parked, re-pointed at another ATS, or replaced by a marketing page. None of
 * those renders `article.article--result`, so parseAvatureSearch returned no
 * postings, the zero-postings break ended the loop and listPostings resolved with
 * [] — indistinguishable from a portal with nothing open. Nothing failed, so
 * consecutive_failures never moved.
 *
 * "No result articles" alone cannot be the signal: the engine renders a portal
 * page with zero of them whenever nothing matches. Probed 2026-08-03, the portal
 * HOME pages of jobs.lenovo.com and www.metlifecareers.com both carry zero
 * article--result blocks while still stamping avature.portal.id — proof the meta
 * namespace is portal chrome rather than a property of the results list.
 * Present on 9/9 live rows.
 *
 * /jscore/ is accepted alongside the meta on purpose, and NOT as a nicety: the
 * engine's own transient failure page ("Oops... Something went wrong", HTTP 200,
 * reproduced on jobs.lenovo.com) drops every meta tag but still loads /jscore/
 * assets. Keying on the meta alone would have charged a healthy Lenovo board for
 * a vendor-side hiccup. A host that has stopped serving Avature has neither.
 *
 * Gated to page 1, so the stale "No jobs found" placeholder a page past the real
 * last one renders still just ends pagination.
 *
 * A bot-blocker's challenge page carries neither marker either, and eight of the
 * nine rows sit on a host that can be WAF-fronted — so the body is checked for a
 * block signature first and, when it is one, the error thrown is
 * infrastructure-shaped instead: an edge refusing us is retried and deferred, never
 * charged to the row.
 */
export function assertAvatureBoardServed(html: string, url: string): void {
  if (avatureEngineServed(html)) return;
  assertNotEdgeChallenge("avature", url, html);

  throw new Error(
    `avature: portal no longer served — ${url} returned a page with no job articles and none of ` +
      `Avature's own portal markup, so it is not an Avature portal and the board is dead rather ` +
      `than empty.`,
  );
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

/** Extract the JD body as plain text. The description lives in
 *  `section.section--description`; a bare `.section__content` first-match
 *  grabs the metadata SIDEBAR on some skins (L'Oréal served 80-97 char
 *  "JDs" of location tags while the real 4.5k-char body sat one section
 *  over — verified live 2026-08-13). Fall back to the old selector for
 *  skins without the description section class. */
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
      // Checked first (before fetching another page) so this is the ONLY
      // path that sets hitCap — the empty-page and no-next-link stops below
      // are genuine, unambiguous completions and must never be confused with
      // a cap truncation.
      if (page >= MAX_PAGES) {
        hitCap = true;
        break;
      }
      const { html, finalUrl } = await atsFetchHtml(url, { provider: "avature" });
      const { postings, nextHref } = parseAvatureSearch(html, finalUrl, company);
      // A page past the real last one can render a stale "No jobs found"
      // placeholder that still carries a (wrong) Next link — stop here
      // regardless of nextHref so that case can never loop.
      if (postings.length === 0) {
        // On the FIRST page only: zero postings from something that isn't even an
        // Avature portal means the host stopped serving the board. Past page 1 it
        // just means the pager ran off the end, which is a clean completion.
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
