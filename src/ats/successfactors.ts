// src/ats/successfactors.ts — SAP SuccessFactors career sites on the LEGACY
// Jobs2Web / classic Career Site Builder engine, mounted on each company's
// CUSTOM domain (e.g. jobs.heromotocorp.com, careers.sunpharma.com). NOT the
// gated SAPUI5 app at career4.successfactors.com.
//
// The engine serves clean, unauthenticated, server-rendered Bootstrap-3 HTML:
//
//   list: GET <origin>/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=<N>
//         -> rows `<tr class="data-row">`, each with
//              a.jobTitle-link  href="/job/<slug>/<reqId>/"  (the title)
//              .jobLocation     (city/region string)
//              .jobDate         (posted date, tenant-formatted)
//         Total count is inline as text "Results 1 to 25 of <TOTAL>".
//         Page size is 25 (startrow += 25).
//
//   jd:   GET <origin>/job/<slug>/<reqId>/  -> full rich HTML in span.jobdescription
//
// Column ORDER varies per tenant (some put date before title), so every field is
// selected by class WITHIN each row, never by column position. Each row renders
// twice (a .hidden-phone desktop copy and a .visible-phone mobile copy); we take
// the first match of each class per row, which is stable across both layouts.
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const PAGE = 25; // engine-fixed page size
// Safety cap: 125,000 jobs (PAGE 25 x MAX_PAGES 5000). paginate stops earlier
// once it reaches the parsed total; this only bites pathologically large
// boards. listPostings logs when hit.
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

/** Origin (scheme + host) that serves the board — the custom career domain.
 *  Prefers tenant_url when set, else the careers_url (root or /search/ page). */
export function successfactorsOrigin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/** Paged search URL at the given 0-based row offset. */
export function successfactorsSearchUrl(origin: string, startrow: number): string {
  return `${origin}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
}

/** Parse the "Results 1 to 25 of <TOTAL>" banner. Null when absent. */
export function parseSuccessfactorsTotal(html: string): number | null {
  const m = html.match(/Results\s+[\d,]+\s+to\s+[\d,]+\s+of\s+([\d,]+)/i);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** reqId + slug from a "/job/<slug>/<reqId>/" href. The "/job/<slug>/<reqId>"
 *  pair may appear ANYWHERE in the path, not just at the root: multi-brand
 *  tenants prefix real postings with a subsidiary segment
 *  (e.g. "/TaroPharma/job/Hawthorne-Line-Mechanic/6196744/"). Null when the
 *  shape doesn't match. */
export function parseJobHref(href: string): { slug: string; reqId: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const m = path.match(/\/job\/([^/]+)\/([^/]+)\/?$/);
  if (!m?.[1] || !m[2]) return null;
  return { slug: m[1], reqId: m[2] };
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Parse one /search/ page: its postings, the raw `<tr class="data-row">` count
 *  (the server's page size — used to advance the row offset regardless of how
 *  many rows survive filtering), and the reported total (if present). */
export function parseSuccessfactorsSearch(
  html: string,
  company: AdapterCompany,
): { postings: NormalizedPosting[]; rowCount: number; total: number | null } {
  const origin = successfactorsOrigin(company);
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];
  const rows = $("tr.data-row");

  rows.each((_, row) => {
    const $row = $(row);
    const $link = $row.find("a.jobTitle-link").first();
    const href = $link.attr("href");
    const title = cleanText($link.text());
    if (!href || !title) return;

    const parsed = parseJobHref(href);
    if (!parsed) return;

    const locEl = $row.find(".colLocation .jobLocation").first();
    const locText = cleanText((locEl.length ? locEl : $row.find(".jobLocation").first()).text());
    const location = locText || null;

    const dateEl = $row.find(".colDate .jobDate").first();
    const dateText = cleanText((dateEl.length ? dateEl : $row.find(".jobDate").first()).text());

    let jobUrl: string;
    try {
      jobUrl = new URL(href, origin).toString();
    } catch {
      return;
    }

    postings.push({
      provider: "successfactors",
      externalId: parsed.reqId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: "",
      postedAt: dateToIso(dateText || null),
    });
  });

  // Tile-view skin: some tenants (e.g. careers.trentlimited.com) render the
  // same engine's results as <li class="job-tile" data-url="/job/<slug>/<reqId>/">
  // cards instead of <tr class="data-row"> table rows. Same jobTitle-link
  // anchor inside; location lives in a labeled .section-field.location block.
  if (rows.length === 0) {
    const tiles = $("li.job-tile");
    tiles.each((_, tile) => {
      const $tile = $(tile);
      const $link = $tile.find("a.jobTitle-link").first();
      const href = $link.attr("href") ?? $tile.attr("data-url");
      const title = cleanText($link.text());
      if (!href || !title) return;

      const parsed = parseJobHref(href);
      if (!parsed) return;

      const locText = cleanText($tile.find(".section-field.location div[id$='-value']").first().text());
      const location = locText || null;

      let jobUrl: string;
      try {
        jobUrl = new URL(href, origin).toString();
      } catch {
        return;
      }

      postings.push({
        provider: "successfactors",
        externalId: parsed.reqId,
        companySlug: company.slug,
        companyName: company.name,
        jobTitle: title,
        jobUrl,
        location,
        isRemote: location ? REMOTE_RE.test(location) : false,
        jdText: "",
        postedAt: null,
      });
    });
    return { postings, rowCount: tiles.length, total: parseSuccessfactorsTotal(html) };
  }

  return { postings, rowCount: rows.length, total: parseSuccessfactorsTotal(html) };
}

/** Extract the JD body (span.jobdescription) as plain text. */
export function parseSuccessfactorsJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $("span.jobdescription").first();
  if (!el.length) return "";
  const inner = el.html();
  return inner ? htmlToText(inner) : cleanText(el.text());
}

export const successfactorsAdapter: AtsAdapter = {
  provider: "successfactors",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = successfactorsOrigin(company);
    // Boxed in an object: a bare `let total` mutated only inside the fetchPage
    // closure defeats TS's narrowing (it can't see paginate() invoking the
    // closure, so it treats `total` as permanently its initial `null`); a
    // property write is narrowed correctly at each read below.
    const state: { total: number | null } = { total: null };
    const seenIds = new Set<string>();

    const postings = await paginate<NormalizedPosting>({
      provider: "successfactors",
      company: company.slug,
      pageSize: PAGE,
      maxPages: MAX_PAGES,
      fetchPage: async (offset) => {
        const html = await atsFetchText(successfactorsSearchUrl(origin, offset), {
          provider: "successfactors",
        });
        const page = parseSuccessfactorsSearch(html, company);
        if (state.total === null) state.total = page.total;
        // Some tenants CLAMP an out-of-range startrow and re-serve the last
        // page instead of an empty one (verified live on careers.acer.com,
        // whose tile skin also omits the results banner, so `total` never
        // stops the loop either). A page that adds no NEW reqIds is the end
        // of the board — without this, paginate spins to MAX_PAGES.
        const fresh = page.postings.filter((p) => !seenIds.has(p.externalId));
        if (page.postings.length > 0 && fresh.length === 0) {
          return { items: [], total: page.total, rawCount: 0 };
        }
        for (const p of fresh) seenIds.add(p.externalId);
        // Advance by the server's row count (25 on a full page), NOT the number
        // of postings that survived filtering — otherwise a single filtered row
        // shortens the page and paginate would stop before the real last page.
        return { items: fresh, total: page.total, rawCount: page.rowCount };
      },
    });

    // Warn on a genuine safety-cap truncation (board needs more pages than
    // MAX_PAGES).
    const total = state.total;
    if (total !== null && Math.ceil(total / PAGE) > MAX_PAGES) {
      logger.warn(
        { slug: company.slug, collected: postings.length, total, maxPages: MAX_PAGES },
        "successfactors pagination capped — board larger than the safety limit",
      );
    } else if (total !== null && postings.length < total) {
      // Collected fewer postings than the banner total without hitting the cap.
      // NOT necessarily benign — a row whose href we couldn't parse is a REAL
      // dropped posting (e.g. an unhandled brand-prefixed /job/ path), so surface
      // it rather than swallowing it silently.
      logger.info(
        { slug: company.slug, collected: postings.length, total },
        "successfactors collected fewer postings than the reported total — some rows were not parsed",
      );
    }

    return postings;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "successfactors" });
    return parseSuccessfactorsJd(html);
  },
};
