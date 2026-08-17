// src/ats/successfactors.ts — SAP SuccessFactors LEGACY Jobs2Web/Career Site Builder engine, on each company's custom domain (NOT the gated SAPUI5 app at career4.successfactors.com).
// List: GET <origin>/search/?...&startrow=<N>, unauthenticated server-rendered HTML with tr.data-row rows; page size is a per-TENANT setting (10-25), so paginate() infers it from the first page. JD: GET <origin>/job/<slug>/<reqId>/, span.jobdescription.
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin, collapseWs } from "./shared.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import { BROWSER_UA } from "../util/userAgent.js";

const MAX_PAGES = 5000; // runaway backstop only - paginate stops earlier once it reaches the parsed total

/** Paged search URL at the given 0-based row offset. */
export function successfactorsSearchUrl(origin: string, startrow: number): string {
  return `${origin}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
}

// Detecting "board is dead" (parked/re-pointed domain) needs a POSITIVE "the engine rendered" marker, not the results banner or row containers - some live but currently-empty boards have neither (reproducible on any healthy tenant by searching a nonsense keyword).
// Every J2W page loads /platform/{css,js}/j2w/ assets, including on empty and no-results pages, so its absence (not zero rows) is what marks a dead tenant.
const J2W_ENGINE_RE = /\/platform\/(?:css|js)\/j2w\//i;

/** Whether this page came from the Jobs2Web engine at all - see J2W_ENGINE_RE. */
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

/** Location for a tile: standard labeled block, else a tenant-relabeled customfield ("Location"/"City", or a bare "Country/Region"), else fall back to the city token baked into the job slug (e.g. "/job/NAVI-MUMBAI-.../id/"). */
type TileSelection = ReturnType<cheerio.CheerioAPI>;
export function tileLocation($: cheerio.CheerioAPI, $tile: TileSelection, jobSlug: string): string | null {
  const std = collapseWs($tile.find(".section-field.location div[id$='-value']").first().text());
  if (std !== "") return std;

  // Boxed: assignments inside the .each() closure defeat TS narrowing on bare lets.
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

  // Slug fallback: leading UPPERCASE tokens before the title words are the city SF prepends to the slug.
  const m = /^([A-Z][A-Z .]*(?:-[A-Z][A-Z .]*)*)-/.exec(jobSlug);
  const city = m?.[1]?.replace(/-/g, " ").trim() ?? "";
  return city !== "" && city.length >= 3 ? city : null;
}

/** reqId + slug from a "/job/<slug>/<reqId>/" href; the pair may appear anywhere in the path, not just at the root (multi-brand tenants prefix a subsidiary segment). Null when the shape doesn't match. */
export function parseJobHref(href: string): { slug: string; reqId: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const m = path.match(/\/job\/([^/]+)\/([^/]+)\/?$/);
  if (!m?.[1] || !m[2]) return null;
  return { slug: m[1], reqId: m[2] };
}

// Column ORDER varies per tenant (some put date before title), so every field is selected by class within a row, never by position; each row renders twice (desktop/mobile copies) and the first match of each class is taken.
/** Parse one /search/ page: its postings, the raw row count (used to advance the offset regardless of how many rows survive filtering), and the reported total (if present). */
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

  // Tile-view skin: some tenants render the same engine's results as <li class="job-tile"> cards instead of <tr class="data-row"> rows, with the same jobTitle-link anchor inside.
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
    // Boxed in an object: bare `let`s mutated only inside the fetchPage closure defeat TS's narrowing; property writes narrow correctly at each read below.
    const state: { total: number | null; pageSize: number | null } = { total: null, pageSize: null };
    // Tracks seen externalIds purely to detect an all-duplicate page below; actual cross-page dedup of `postings` is delegated to paginate()'s dedupeBy.
    const seenIds = new Set<string>();

    const postings = await paginate<NormalizedPosting>({
      provider: "successfactors",
      company: company.slug,
      // Tenant-set, not engine-set - a hardcoded 25 falsely looks short on 10-row tenants and truncates them at page 1.
      pageSize: "infer",
      maxPages: MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, pageNum) => {
        // Some tenants 404 the bot UA outright; browser UA is accepted by all.
        const html = await atsFetchText(successfactorsSearchUrl(origin, offset), {
          provider: "successfactors",
          userAgent: BROWSER_UA,
        });
        const page = parseSuccessfactorsSearch(html, company);
        // Page 1 only, and only once it produced no row containers - a page that rendered rows is a live board regardless, and never gates a board that already yielded postings.
        if (pageNum === 0 && page.rowCount === 0 && !isSuccessfactorsEngine(html)) {
          // A bot-blocker's challenge page carries none of the engine's assets either - reclassify first so an edge refusing us is retried/deferred instead of counted toward quarantine.
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
        // Some tenants clamp an out-of-range startrow and re-serve the last page instead of an empty one; a page adding no NEW reqIds is the end of the board (without this, paginate spins to MAX_PAGES).
        const allSeen = page.postings.length > 0 && page.postings.every((p) => seenIds.has(p.externalId));
        for (const p of page.postings) seenIds.add(p.externalId);
        if (allSeen) {
          return { items: [], total: page.total, rawCount: 0 };
        }
        // Advance by the server's row count, not the postings that survive dedupeBy - a repeat row would otherwise shorten the page and stop before the real last one.
        return { items: page.postings, total: page.total, rawCount: page.rowCount };
      },
    });

    const total = state.total;
    const pageSize = state.pageSize;
    if (total !== null && pageSize !== null && Math.ceil(total / pageSize) > MAX_PAGES) {
      logger.warn(
        { slug: company.slug, collected: postings.length, total, maxPages: MAX_PAGES },
        "successfactors pagination capped — board larger than the safety limit",
      );
    } else if (total !== null && postings.length < total) {
      // Not necessarily benign - a row whose href we couldn't parse is a real dropped posting, so surface it rather than swallowing it silently.
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
