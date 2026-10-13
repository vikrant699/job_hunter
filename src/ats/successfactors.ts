// List: GET <origin>/search/?...&startrow=<N>, server-rendered tr.data-row rows; page size is per-tenant (10-25), inferred by paginate(). JD: GET <origin>/job/<slug>/<reqId>/, span.jobdescription.
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin, collapseWs } from "./shared.js";
import { fetchSfSitemapIds, sitemapOnlyEntries, titleFromSitemapUrl } from "./sfSitemap.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";
import { BROWSER_UA } from "../util/userAgent.js";

const MAX_PAGES = 5000;

export function successfactorsSearchUrl(origin: string, startrow: number): string {
  return `${origin}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
}

// Dead board = the engine's /platform/{css,js}/j2w/ assets are absent; the results banner or row containers can't tell (live empty boards lack both).
const J2W_ENGINE_RE = /\/platform\/(?:css|js)\/j2w\//i;

export function isSuccessfactorsEngine(html: string): boolean {
  return J2W_ENGINE_RE.test(html);
}

export function parseSuccessfactorsTotal(html: string): number | null {
  const m = html.match(/Results\s+[\d,]+\s+to\s+[\d,]+\s+of\s+([\d,]+)/i);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

type TileSelection = ReturnType<cheerio.CheerioAPI>;
export function tileLocation($: cheerio.CheerioAPI, $tile: TileSelection, jobSlug: string): string | null {
  const std = collapseWs($tile.find(".section-field.location div[id$='-value']").first().text());
  if (std !== "") return std;

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

  const m = /^([A-Z][A-Z .]*(?:-[A-Z][A-Z .]*)*)-/.exec(jobSlug);
  const city = m?.[1]?.replace(/-/g, " ").trim() ?? "";
  return city !== "" && city.length >= 3 ? city : null;
}

/** The pair may sit anywhere in the path: multi-brand tenants prefix a subsidiary segment. */
export function parseJobHref(href: string): { slug: string; reqId: string } | null {
  const path = href.split(/[?#]/)[0] ?? "";
  const m = path.match(/\/job\/([^/]+)\/([^/]+)\/?$/);
  if (!m?.[1] || !m[2]) return null;
  return { slug: m[1], reqId: m[2] };
}

// Column order varies per tenant and each row renders twice (desktop/mobile), so select by class and take the first match.
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

  // Some tenants render <li class="job-tile"> cards instead of <tr class="data-row"> rows.
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

function successfactorsPostingFromSitemap(company: AdapterCompany, id: string, url: string): NormalizedPosting {
  const jobTitle = titleFromSitemapUrl(url);
  return {
    provider: "successfactors",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle,
    jobUrl: url,
    location: null,
    isRemote: REMOTE_RE.test(jobTitle),
    jdText: "",
    postedAt: null,
  };
}

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
    const state: { total: number | null; pageSize: number | null } = { total: null, pageSize: null };
    const seenIds = new Set<string>();

    const postings = await paginate<NormalizedPosting>({
      provider: "successfactors",
      company: company.slug,
      // Tenant-set, not engine-set: a hardcoded 25 looks short on 10-row tenants and truncates them at page 1.
      pageSize: "infer",
      maxPages: MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, pageNum) => {
        // Some tenants 404 the bot UA outright.
        const html = await atsFetchText(successfactorsSearchUrl(origin, offset), {
          provider: "successfactors",
          userAgent: BROWSER_UA,
        });
        const page = parseSuccessfactorsSearch(html, company);
        if (pageNum === 0 && page.rowCount === 0 && !isSuccessfactorsEngine(html)) {
          // A bot-blocker's challenge page also lacks the engine assets; reclassify first so it's retried, not counted toward quarantine.
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
        // Some tenants clamp an out-of-range startrow and re-serve the last page; a page adding no new reqIds ends the board.
        const allSeen = page.postings.length > 0 && page.postings.every((p) => seenIds.has(p.externalId));
        for (const p of page.postings) seenIds.add(p.externalId);
        if (allSeen) {
          return { items: [], total: page.total, rawCount: 0 };
        }
        // Advance by the server's row count, not surviving postings, or a repeat row shortens the page and stops early.
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
      logger.info(
        { slug: company.slug, collected: postings.length, total },
        "successfactors collected fewer postings than the reported total — some rows were not parsed",
      );
    }

    const seen = new Set(postings.map((p) => p.externalId));
    const out = postings.slice();
    const sitemapIds = await fetchSfSitemapIds(company, "successfactors");
    let gapFilled = 0;
    if (sitemapIds) {
      for (const [id, url] of sitemapOnlyEntries(sitemapIds, seen, { slug: company.slug, provider: "successfactors" })) {
        out.push(successfactorsPostingFromSitemap(company, id, url));
        gapFilled++;
      }
    }
    logger.info(
      { slug: company.slug, api: postings.length, sitemap: sitemapIds?.size ?? 0, gapFilled },
      `successfactors ${company.slug}: api=${postings.length} sitemap=${sitemapIds?.size ?? 0} gapFilled=${gapFilled}`,
    );
    return out;
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "successfactors", userAgent: BROWSER_UA });
    return parseSuccessfactorsJd(html);
  },
};
