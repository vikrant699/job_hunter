// src/ats/jio.ts — Reliance Jio careers (careers.jio.com), a legacy ASP.NET
// WebForms site. Covers the Jio-group rows (Reliance Jio / Jio Platforms /
// Jio Payments Bank) — one careers portal.
//
// Shape (verified live 2026-08-13, ~30k postings across 24 job functions):
//   functions: GET frmJobCategories.aspx -> 24 <a href="frmfuncwisejob.aspx
//              ?func=&desc=&flag="> links (opaque but stable query tokens), the
//              anchor text is the function name.
//   per-func:  GET frmfuncwisejob.aspx?func=… server-renders 10 rows; each row is
//              an <a id="…hylUser_N" href="frmjobdescription.aspx?JBTITLE=&jbID=
//              &funcCode="> whose text is "Title ( <jobcode> )", with the city in
//              a sibling <span id="…Label2_N">.
//   PAGINATION IS BROWSER-ONLY: the DataPager pages via an ASP.NET UpdatePanel
//              async postback (__doPostBack); replaying it with a bare HTTP POST
//              is F5-WAF-blocked (302 -> /index.aspx). So each function is walked
//              in a real browser: set page size to 25, then click Next until the
//              pager stops. (The function list and per-job JD are plain fetches —
//              only the pager needs the browser.)
//   jd:        GET frmjobdescription.aspx?… -> spans lblSummRole / lblEduReq /
//              lblExpReq / lblSkill (role, education, experience, skills). Plain fetch.
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { withBrowserPage } from "./browserFetch.js";
import { REMOTE_RE } from "./shared.js";

const ORIGIN = "https://careers.jio.com";
const FUNCTIONS_URL = `${ORIGIN}/frmJobCategories.aspx`;
const PAGE_SIZE_SELECT = "#MainContent_ddlentries";
// The DataPager's Next is an ASP.NET <input type="submit">, disabled on the last
// page via a `disabled` attribute + the `aspNetDisabled` class.
const NEXT_SELECTOR = "input[id$='lnkNext']";
// Runaway guard only — a function with this many pages of 25 is 125k jobs.
const MAX_PAGES_PER_FUNCTION = 5000;

export interface JioFunction {
  url: string;
  name: string;
}

/** Decode the HTML entities cheerio leaves in an href attribute value. */
function unentity(s: string): string {
  return s.replace(/&amp;/g, "&");
}

/** Absolute URL for a relative careers.jio.com path (frmfuncwisejob/frmjobdescription). */
function absolute(href: string): string {
  const clean = unentity(href);
  return clean.startsWith("http") ? clean : `${ORIGIN}/${clean.replace(/^\/+/, "")}`;
}

export function parseJioFunctions(html: string): JioFunction[] {
  const $ = cheerio.load(html);
  const out: JioFunction[] = [];
  const seen = new Set<string>();
  $("a[href*='frmfuncwisejob.aspx']").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    const url = absolute(href);
    if (seen.has(url)) return;
    // Name = anchor text without a trailing job-count number/badge.
    const name = $a.text().replace(/\s*\d[\d,]*\s*(jobs?)?\s*$/i, "").replace(/\s+/g, " ").trim();
    if (!name) return;
    seen.add(url);
    out.push({ url, name });
  });
  return out;
}

/** "Frontend Engineer ( 86701445 )" -> { title, jobcode }. jobcode null when the
 *  " ( <digits> )" suffix is absent. */
export function splitJioTitle(raw: string): { title: string; jobcode: string | null } {
  const m = raw.match(/^(.*?)\s*\(\s*(\d+)\s*\)\s*$/);
  if (m?.[1] && m[2]) return { title: m[1].trim(), jobcode: m[2] };
  return { title: raw.replace(/\s+/g, " ").trim(), jobcode: null };
}

/** The jbID query token from a frmjobdescription href (fallback external id). */
function jbIdOf(href: string): string | null {
  const m = unentity(href).match(/[?&]jbID=([^&]+)/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export function parseJioRows(company: AdapterCompany, html: string): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  $("a[id*='hylUser_']").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    const idxMatch = ($a.attr("id") ?? "").match(/hylUser_(\d+)/);
    const idx = idxMatch?.[1];
    const { title, jobcode } = splitJioTitle($a.text());
    if (!title) return;
    const externalId = jobcode ?? jbIdOf(href);
    if (!externalId || seen.has(externalId)) return;

    // Location: the sibling Label2_<same index> span (holds the city).
    const loc = idx !== undefined
      ? cheerioText($, `span[id$='Label2_${idx}']`)
      : null;

    seen.add(externalId);
    out.push({
      provider: "jio",
      externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: absolute(href),
      location: loc,
      isRemote: loc ? REMOTE_RE.test(loc) : false,
      jdText: "",
      postedAt: null,
    });
  });
  return out;
}

function cheerioText($: cheerio.CheerioAPI, sel: string): string | null {
  const t = $(sel).first().text().replace(/\s+/g, " ").trim();
  return t || null;
}

const JD_SPANS = ["lblSummRole", "lblEduReq", "lblExpReq", "lblSkill"];

export function parseJioJd(html: string): string {
  const $ = cheerio.load(html);
  const parts: string[] = [];
  for (const span of JD_SPANS) {
    const el = $(`span[id$='${span}']`).first();
    if (el.length) {
      const t = htmlToText(el.html() ?? "");
      if (t.trim()) parts.push(t);
    }
  }
  return parts.join("\n\n").trim();
}

/** Whether the pager's Next submit-button is live, vs disabled on the last page
 *  (`disabled` attribute or the `aspNetDisabled` class) or absent. */
export function jioNextIsClickable(html: string): boolean {
  const $ = cheerio.load(html);
  const next = $(NEXT_SELECTOR).first();
  if (next.length === 0) return false;
  if (next.attr("disabled") !== undefined) return false;
  return !(next.attr("class") ?? "").split(/\s+/).includes("aspNetDisabled");
}

/** Walk ONE job function to the end in a browser: set 25/page, then click Next
 *  until the pager stops, deduping rows by externalId across pages. */
async function crawlJioFunction(company: AdapterCompany, fn: JioFunction): Promise<NormalizedPosting[]> {
  return withBrowserPage(fn.url, async (page) => {
    const rows = new Map<string, NormalizedPosting>();
    // Raise the page size to the pager's max so we do fewer round trips.
    try {
      if (await page.locator(PAGE_SIZE_SELECT).count()) {
        await page.selectOption(PAGE_SIZE_SELECT, "25");
        await page.waitForTimeout(1500);
      }
    } catch {
      /* some functions render without the size control — fine, 10/page */
    }

    for (let pageNo = 0; pageNo < MAX_PAGES_PER_FUNCTION; pageNo++) {
      const html = await page.content();
      const before = rows.size;
      for (const r of parseJioRows(company, html)) if (!rows.has(r.externalId)) rows.set(r.externalId, r);

      if (!jioNextIsClickable(html)) break;
      const added = rows.size - before;
      // A live Next that adds nothing new means the pager looped — stop rather
      // than spin (mirrors the shared paginate stall guard).
      if (pageNo > 0 && added === 0) break;

      const next = page.locator(NEXT_SELECTOR).first();
      try {
        await next.click();
        await page.waitForTimeout(1500); // async postback DOM swap
      } catch {
        break;
      }
    }
    logger.debug({ company: company.slug, function: fn.name, jobs: rows.size }, "jio: function crawled");
    return [...rows.values()];
  });
}

export const jioAdapter: AtsAdapter = {
  provider: "jio",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const functions = parseJioFunctions(await atsFetchText(FUNCTIONS_URL, { provider: "jio" }));
    if (functions.length === 0) throw new Error("jio: no job functions found on frmJobCategories.aspx");

    const all = new Map<string, NormalizedPosting>();
    for (const fn of functions) {
      const jobs = await crawlJioFunction(company, fn);
      for (const j of jobs) if (!all.has(j.externalId)) all.set(j.externalId, j);
    }
    logger.info({ company: company.slug, functions: functions.length, jobs: all.size }, "jio: board crawled");
    return [...all.values()];
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    // JD page is a plain fetch (only the pager is WAF-gated).
    return parseJioJd(await atsFetchText(posting.jobUrl, { provider: "jio" }));
  },
};
