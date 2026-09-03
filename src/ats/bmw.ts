// list: capture the page's own jobfinder fragment URL (India filter baked in), then page it via rowIndex -> HTML keyed by `.grp-jobfinder__wrapper[data-job-id]`; `data-counter` is the true total
// plain Node fetch is TLS-refused by Akamai Bot Manager - runs through the shared headless browser to clear the WAF
import * as cheerio from "cheerio";
import type { Page } from "playwright";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { withBrowserPage, captureFirstRequest } from "./browserFetch.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE } from "./shared.js";

const FRAG_RE = /jobfinder\d*\.jobfinder_table\.content\.html/i;
const MAX_FRAG_PAGES = 200; // runaway backstop, India never approaches this
const MAX_JD_FETCHES = 60; // cap so a pathologically large board can't stall the tick; rest keep title+location only

export interface BmwTile {
  externalId: string;
  jobTitle: string;
  location: string | null;
  legalEntity: string | null;
  detailUrl: string;
  postedAt: string | null;
}

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

export function extractBmwJd(html: string): string {
  const $ = cheerio.load(html);
  const el = $(".grp-jobdescription__content").first();
  if (el.length > 0) return htmlToText(el.html() ?? "");
  const main = $("main").first();
  return htmlToText(main.length > 0 ? (main.html() ?? "") : $("body").html() ?? "");
}

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

    // Registered from beforeGoto (pre-navigation) since the fragment request can fire during initial load.
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
        waitUntil: "networkidle", // Akamai interstitial / slow settle is swallowed; the fragment may still fire
        settleMs: 0, // captureFirstRequest's own timeout below replaces the fixed settle wait
        blockHeavyAssets: false,
        // 51_000 = navTimeoutMs (45_000) + ~6_000 polling margin, timed from listener registration (pre-goto).
        beforeGoto: (page) => { fragUrlPromise = captureFirstRequest(page, FRAG_RE, 51_000); },
      },
    );
  },
};
