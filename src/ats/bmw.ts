// src/ats/bmw.ts — BMW Group careers (bmwgroup.jobs), an Adobe AEM "grpw-web"
// job-finder. The whole domain is behind Akamai Bot Manager at the TLS level:
// plain Node fetch (any headers) is refused before any HTTP response, so this
// adapter runs through the shared headless browser, which clears the WAF.
//
// Once the page loads, its own JS fetches an HTML fragment for the job table:
//   GET <origin>/<locale-path>/jobs/_jcr_content/main/<container>/jobfinder30
//       .jobfinder_table.content.html?filterSearch=location_IN&rowIndex=<N>&blockCount=<B>
// The country is baked into the page URL (/in/en/jobs.html is pre-filtered to
// India via filterSearch=location_IN), so we don't construct the fragment URL
// ourselves — we capture the exact one the page requests (container id and
// filter included) and then page it by bumping rowIndex.
//
// The fragment is fully structured HTML (NO LLM needed): each
// `.grp-jobfinder__wrapper[data-job-id]` holds a `.grp-jobfinder-cell-refno`
// with data-job-title / data-job-location / data-job-legal-entity /
// data-posting-date, plus a detail link `/…/job-description-copy.<id>.html`.
// `data-counter` on the table is the true India total. JD lives in
// `.grp-jobdescription__content` on the detail page; because the board is
// tiny (India routinely has a handful of roles) we fetch every JD inside the
// same WAF-cleared browser session during listing, so location AND JD are
// both exact and there's no second WAF handshake per posting.
import * as cheerio from "cheerio";
import type { Page } from "playwright";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { withBrowserPage, captureFirstRequest } from "./browserFetch.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE } from "./shared.js";

const FRAG_RE = /jobfinder\d*\.jobfinder_table\.content\.html/i;
// Safety cap on fragment pages (blockCount rows each) — India never
// approaches this; it's a runaway backstop only.
const MAX_FRAG_PAGES = 200;
// Cap inline JD fetches so a pathologically large India board can't stall the
// tick; postings beyond this keep title+location and get their JD on a later
// run. Comfortably above any real BMW-India vacancy count.
const MAX_JD_FETCHES = 60;

export interface BmwTile {
  externalId: string;
  jobTitle: string;
  location: string | null;
  legalEntity: string | null;
  detailUrl: string;
  postedAt: string | null;
}

/** Parse one jobfinder fragment: the tiles + the reported India total. */
export function parseBmwFragment(html: string, origin: string): { tiles: BmwTile[]; total: number | null } {
  const $ = cheerio.load(html);
  const totalAttr = $(".grp-jobfinder__table").first().attr("data-counter");
  const total = totalAttr && /^\d+$/.test(totalAttr) ? Number(totalAttr) : null;

  const tiles: BmwTile[] = [];
  $(".grp-jobfinder__wrapper").each((_, el) => {
    const $w = $(el);
    const id = $w.attr("data-job-id");
    const $cell = $w.find(".grp-jobfinder-cell-refno").first();
    const jobTitle = ($cell.attr("data-job-title") ?? "").trim();
    if (!id || !jobTitle) return;
    const href = $w.find("a.grp-jobfinder__link-jobdescription").first().attr("href") ?? "";
    let detailUrl = origin;
    try { detailUrl = new URL(href, origin).toString(); } catch { /* keep origin */ }
    const postingDate = $cell.attr("data-posting-date") ?? null; // YYYYMMDD
    const postedAt =
      postingDate && /^\d{8}$/.test(postingDate)
        ? `${postingDate.slice(0, 4)}-${postingDate.slice(4, 6)}-${postingDate.slice(6, 8)}`
        : null;
    tiles.push({
      externalId: id,
      jobTitle,
      location: ($cell.attr("data-job-location") ?? "").trim() || null,
      legalEntity: ($cell.attr("data-job-legal-entity") ?? "").trim() || null,
      detailUrl,
      postedAt,
    });
  });
  return { tiles, total };
}

/** Extract the JD text from a detail page's HTML. */
export function extractBmwJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $(".grp-jobdescription__content").first();
  if (el.length > 0) return htmlToText(el.html() ?? "");
  const main = $("main").first();
  return htmlToText(main.length > 0 ? (main.html() ?? "") : $("body").html() ?? "");
}

/** Set rowIndex on a captured fragment URL. */
export function bmwFragmentPageUrl(fragUrl: string, rowIndex: number): string {
  const u = new URL(fragUrl);
  u.searchParams.set("rowIndex", String(rowIndex));
  return u.toString();
}

async function inPageFetch(page: Page, url: string): Promise<string> {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: "text/html,application/xhtml+xml" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  }, url);
}

export const bmwAdapter: AtsAdapter = {
  provider: "bmw",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const pageUrl = company.tenantUrl ?? company.careersUrl;
    const origin = new URL(pageUrl).origin;

    // Capture the exact jobfinder fragment URL the page's own JS requests
    // (carries the container id + India filter); blockCount comes from it.
    // Registered from `beforeGoto` (before navigation) since the request can
    // fire during the initial load — a listener attached after `goto` could
    // miss it. Placeholder is overwritten synchronously by `beforeGoto`
    // before `run` ever reads it.
    let fragUrlPromise: Promise<string | null> = Promise.resolve(null);

    return withBrowserPage(
      pageUrl,
      async (page) => {
        const fragUrl = await fragUrlPromise;
        if (!fragUrl) {
          logger.warn({ slug: company.slug }, "bmw: no jobfinder fragment request observed");
          return [];
        }

        const blockCount = Number(new URL(fragUrl).searchParams.get("blockCount") ?? "5") || 5;

        // Page the fragment by rowIndex until we've collected the reported
        // total (or an empty page).
        const tiles: BmwTile[] = [];
        const seen = new Set<string>();
        let total: number | null = null;
        for (let p = 0; p < MAX_FRAG_PAGES; p++) {
          const html = await inPageFetch(page, bmwFragmentPageUrl(fragUrl, p * blockCount));
          const parsed = parseBmwFragment(html, origin);
          if (total === null) total = parsed.total;
          const before = tiles.length;
          for (const t of parsed.tiles) {
            if (seen.has(t.externalId)) continue;
            seen.add(t.externalId);
            tiles.push(t);
          }
          if (parsed.tiles.length === 0 || tiles.length === before) break;
          if (total !== null && tiles.length >= total) break;
        }

        // Fetch every JD in the SAME cleared session (board is tiny).
        const out: NormalizedPosting[] = [];
        for (const t of tiles) {
          let jdText = "";
          if (out.length < MAX_JD_FETCHES) {
            try {
              jdText = extractBmwJd(await inPageFetch(page, t.detailUrl));
            } catch (e) {
              logger.warn({ slug: company.slug, id: t.externalId, err: String(e).slice(0, 80) }, "bmw JD fetch failed");
            }
          }
          const location = t.location;
          out.push({
            provider: "bmw",
            externalId: t.externalId,
            companySlug: company.slug,
            companyName: company.name,
            jobTitle: t.jobTitle,
            jobUrl: t.detailUrl,
            location,
            isRemote: location ? REMOTE_RE.test(location) : false,
            jdText,
            postedAt: t.postedAt,
          });
        }
        return out;
      },
      {
        navTimeoutMs: 45_000,
        waitUntil: "networkidle", // Akamai interstitial / slow settle is swallowed (default); the fragment may still fire
        settleMs: 0, // captureFirstRequest's own timeout below replaces the fixed settle wait
        blockHeavyAssets: false,
        // Original budget was "up to navTimeoutMs inside goto (interstitial/slow
        // networkidle), THEN up to 6000ms more of polling" — i.e. ~51s worst
        // case measured from listener-registration. captureFirstRequest's
        // timer starts at that same instant (beforeGoto runs pre-goto), so it
        // must cover the full 45_000 + 6_000 to not cut the window short while
        // goto itself is still settling.
        beforeGoto: (page) => { fragUrlPromise = captureFirstRequest(page, FRAG_RE, 51_000); },
      },
    );
  },
};
