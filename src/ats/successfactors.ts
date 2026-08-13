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
//         Page size is a TENANT setting, not an engine constant: 25 rows on
//         jobs.heromotocorp.com, 10 on jobs.mahindracareers.com. Arbitrary
//         startrow offsets are honored, so we advance by the row count the
//         page actually returned and let paginate infer the size.
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
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin, collapseWs } from "./shared.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import { BROWSER_UA } from "../util/userAgent.js";

// Safety cap: 50,000-125,000 jobs, depending on the tenant's page size (10-25
// rows x MAX_PAGES 5000). paginate stops earlier once it reaches the parsed
// total; this only bites pathologically large boards. listPostings logs when hit.
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

/** Paged search URL at the given 0-based row offset. */
export function successfactorsSearchUrl(origin: string, startrow: number): string {
  return `${origin}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
}

// A custom domain that stops serving SuccessFactors — parked by the registrar,
// re-pointed at a marketing page, or fronted by a block page that answers 200 —
// has no rows to parse, so it used to report a healthy board with zero openings
// indefinitely. Detection has to be a POSITIVE "the engine rendered" marker.
//
// It deliberately is NOT the results banner or the row containers. Probed
// 2026-08-02 across all 19 live rows: the banner is on 12, tr.data-row on 12,
// li.job-tile on 5 — and careers.tatapower.com and careers.mankindpharma.com
// have NONE of the three, because they are live Jobs2Web boards currently
// rendering the engine's own "There are currently no open positions" page. A
// guard keyed on those would quarantine both today, and every tenant that ever
// empties out. The same page shape is reproducible on a healthy tenant by
// searching for a nonsense keyword.
//
// The engine's asset namespace survives all of that: every page it serves loads
// /platform/css/j2w/… and /platform/js/j2w/…, j2w being the Jobs2Web lineage
// named at the top of this file. Present on 19/19 live tenants, on both empty
// boards, and on the no-results pages of careers.payu.in and jobs.sap.com.
const J2W_ENGINE_RE = /\/platform\/(?:css|js)\/j2w\//i;

/** Whether this page came from the Jobs2Web engine at all — see J2W_ENGINE_RE. */
export function isSuccessfactorsEngine(html: string): boolean {
  return J2W_ENGINE_RE.test(html);
}

/** Parse the "Results 1 to 25 of <TOTAL>" banner. Null when absent. */
export function parseSuccessfactorsTotal(html: string): number | null {
  const m = html.match(/Results\s+[\d,]+\s+to\s+[\d,]+\s+of\s+([\d,]+)/i);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Location from one tile, across the three tenant variants seen live
 * (2026-08-13): (1) the standard labeled .section-field.location block;
 * (2) tenants that relabel a customfieldN as "Location"/"City" (cipla:
 * customfield2) or expose only "Country/Region" (renew-power: value "IN");
 * (3) tenants whose tiles carry NO fields at all (icici-direct) - fall back
 * to the city token SF itself bakes into the job slug
 * (/job/NAVI-MUMBAI-Sr_-Manager/id/ -> "NAVI MUMBAI").
 */
type TileSelection = ReturnType<cheerio.CheerioAPI>;
export function tileLocation($: cheerio.CheerioAPI, $tile: TileSelection, jobSlug: string): string | null {
  const std = collapseWs($tile.find(".section-field.location div[id$='-value']").first().text());
  if (std !== "") return std;

  // Boxed: assignments inside the .each() closure defeat TS narrowing on
  // bare lets (same pattern as peoplestrong's total box).
  const found: { labeled: string | null; country: string | null } = { labeled: null, country: null };
  $tile.find(".section-field").each((_, f) => {
    const $f = $(f);
    const label = collapseWs($f.find(".section-label").first().text()).toLowerCase();
    const value = collapseWs($f.find("div[id$='-value']").first().text());
    if (value === "") return;
    if (found.labeled === null && (label === "location" || label === "city")) found.labeled = value;
    if (found.country === null && label.startsWith("country")) found.country = value;
  });
  if (found.labeled !== null) return found.labeled;
  if (found.country !== null) return found.country;

  // Slug fallback: leading UPPERCASE tokens before the title words are the
  // city SF prepends to the slug. Take hyphen-joined leading caps tokens.
  const m = /^([A-Z][A-Z .]*(?:-[A-Z][A-Z .]*)*)-/.exec(jobSlug);
  const city = m?.[1]?.replace(/-/g, " ").trim() ?? "";
  return city !== "" && city.length >= 3 ? city : null;
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

/** Parse one /search/ page: its postings, the raw `<tr class="data-row">` count
 *  (the server's page size — used to advance the row offset regardless of how
 *  many rows survive filtering), and the reported total (if present). */
export function parseSuccessfactorsSearch(
  html: string,
  company: AdapterCompany,
): { postings: NormalizedPosting[]; rowCount: number; total: number | null } {
  const origin = tenantOrigin(company);
  const $ = cheerio.load(html);
  const postings: NormalizedPosting[] = [];
  const rows = $("tr.data-row");

  rows.each((_, row) => {
    const $row = $(row);
    const $link = $row.find("a.jobTitle-link").first();
    const href = $link.attr("href");
    const title = collapseWs($link.text());
    if (!href || !title) return;

    const parsed = parseJobHref(href);
    if (!parsed) return;

    const locEl = $row.find(".colLocation .jobLocation").first();
    const locText = collapseWs((locEl.length ? locEl : $row.find(".jobLocation").first()).text());
    const location = locText || null;

    const dateEl = $row.find(".colDate .jobDate").first();
    const dateText = collapseWs((dateEl.length ? dateEl : $row.find(".jobDate").first()).text());

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
      const title = collapseWs($link.text());
      if (!href || !title) return;

      const parsed = parseJobHref(href);
      if (!parsed) return;

      const location = tileLocation($, $tile, parsed.slug);

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
  return inner ? htmlToText(inner) : collapseWs(el.text());
}

export const successfactorsAdapter: AtsAdapter = {
  provider: "successfactors",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = tenantOrigin(company);
    // Boxed in an object: bare `let`s mutated only inside the fetchPage closure
    // defeat TS's narrowing (it can't see paginate() invoking the closure, so it
    // treats them as permanently their initial `null`); property writes are
    // narrowed correctly at each read below. `pageSize` is the tenant's own
    // first-page row count, needed only for the cap math in the logs.
    const state: { total: number | null; pageSize: number | null } = { total: null, pageSize: null };
    // Tracks which externalIds have been seen, purely to detect an
    // all-duplicate page below - the actual cross-page dedup of what
    // ACCUMULATES into `postings` is delegated to paginate()'s dedupeBy.
    // (paginate() has no way to report "how many of this page were new" back
    // out, so this lightweight peek - populated the same way dedupeBy's own
    // internal set is - is the only way to compute that signal.)
    const seenIds = new Set<string>();

    const postings = await paginate<NormalizedPosting>({
      provider: "successfactors",
      company: company.slug,
      // Tenant-set, not engine-set: a hardcoded 25 made the first page of every
      // 10-row tenant look short and stopped mahindra-group at 10 of 608.
      pageSize: "infer",
      maxPages: MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, pageNum) => {
        // Browser UA: some tenants 404 the bot UA outright (tataelectronics,
        // ihcltata - verified 2026-08-14); the browser UA is accepted by all.
        const html = await atsFetchText(successfactorsSearchUrl(origin, offset), {
          provider: "successfactors",
          userAgent: BROWSER_UA,
        });
        const page = parseSuccessfactorsSearch(html, company);
        // Page 1 only, and only once it has produced no row containers at all.
        // A page that rendered rows is a live board whatever its assets look
        // like, and past the last page the engine keeps serving its own (j2w)
        // markup anyway — so gating here costs nothing and removes any chance
        // of failing a board that already yielded postings.
        if (pageNum === 0 && page.rowCount === 0 && !isSuccessfactorsEngine(html)) {
          // A bot-blocker's challenge page carries none of the engine's assets
          // either — the "200-served block page" this guard's own note named while
          // still charging it to the row. Reclassified first, so an edge refusing
          // us is retried and deferred instead of counting toward quarantine.
          assertNotEdgeChallenge("successfactors", successfactorsSearchUrl(origin, 0), html);
          throw new Error(
            `successfactors: tenant does not exist at ${successfactorsSearchUrl(origin, 0)} — the ` +
              `response carries none of the Jobs2Web engine's assets, so this custom domain is no ` +
              `longer serving the board (parked or re-pointed; a bot-block page is classified ` +
              `separately, as an edge refusal). A live board with nothing open still renders the engine.`,
          );
        }
        if (state.total === null) state.total = page.total;
        if (state.pageSize === null && page.rowCount > 0) state.pageSize = page.rowCount;
        // Some tenants CLAMP an out-of-range startrow and re-serve the last
        // page instead of an empty one (verified live on careers.acer.com,
        // whose tile skin also omits the results banner, so `total` never
        // stops the loop either). A page that adds no NEW reqIds is the end
        // of the board — without this, paginate spins to MAX_PAGES.
        const allSeen = page.postings.length > 0 && page.postings.every((p) => seenIds.has(p.externalId));
        for (const p of page.postings) seenIds.add(p.externalId);
        if (allSeen) {
          return { items: [], total: page.total, rawCount: 0 };
        }
        // Advance by the server's row count (whatever a full page is for this
        // tenant), NOT the postings that survive dedupeBy — otherwise a repeat row
        // shortens the page and paginate would stop before the real last page.
        return { items: page.postings, total: page.total, rawCount: page.rowCount };
      },
    });

    // Warn on a genuine safety-cap truncation (board needs more pages than
    // MAX_PAGES).
    const total = state.total;
    const pageSize = state.pageSize;
    if (total !== null && pageSize !== null && Math.ceil(total / pageSize) > MAX_PAGES) {
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
    const html = await atsFetchText(posting.jobUrl, { provider: "successfactors", userAgent: BROWSER_UA });
    return parseSuccessfactorsJd(html);
  },
};
