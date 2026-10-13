// Akamai blocks non-browser clients: warm an Edge (channel msedge) context per origin first. List: /careers/page/<n>/ until empty.
// JD in .gh-job-single/.entry-content; location (resolved in fetchJd) from WP body class gh_office-<city>.
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { acquirePageSlot } from "../scraper/playwright.js";
import { awaitNetwork } from "../util/connectivity.js";
import { REMOTE_RE } from "./shared.js";
import { assertNotEdgeChallenge } from "../util/errorCause.js";

const ORIGIN = "https://www.sirion.ai";
const WAF_SETTLE_MS = 4000;
const MAX_PAGES = 100;

export function sirionListUrl(page: number): string {
  return page <= 1 ? `${ORIGIN}/careers/` : `${ORIGIN}/careers/page/${page}/`;
}

const JOB_HREF_RE = /\/jobs\/([a-z0-9-]+)\/?$/i;

function absolute(href: string): string {
  return href.startsWith("http") ? href : `${ORIGIN}/${href.replace(/^\/+/, "")}`;
}

function deKebab(slug: string): string {
  return slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function parseSirionList(company: AdapterCompany, html: string): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  $("a[href*='/jobs/']").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    const slug = href.match(JOB_HREF_RE)?.[1];
    if (!slug || seen.has(slug)) return;
    const title = $a.text().trim() || $a.closest("article, li, div").find("h1,h2,h3").first().text().trim() || deKebab(slug);
    seen.add(slug);
    out.push({
      provider: "sirion",
      externalId: slug,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: absolute(href),
      location: null,
      isRemote: REMOTE_RE.test(title),
      jdText: "",
      postedAt: null,
    });
  });
  return out;
}

/** A zero-row page that is an Akamai block page throws, so an edge refusal never reads as an empty board. */
export function sirionPagePostings(company: AdapterCompany, url: string, html: string): NormalizedPosting[] {
  const rows = parseSirionList(company, html);
  if (rows.length === 0) assertNotEdgeChallenge("sirion", url, html);
  return rows;
}

export function parseSirionJobTitle(html: string): string {
  const $ = cheerio.load(html);
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;
  const t = $("title").first().text();
  return t.split(/\s+[-|]\s+/)[0]?.trim() ?? "";
}

export function parseSirionJobLocation(html: string): string | null {
  const m = html.match(/gh_office-([a-z0-9_]+)/i);
  const raw = m?.[1];
  if (!raw) return null;
  return raw.split("_").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const JD_SELECTORS = ["article.gh-job-single", ".gh-job-single", ".entry-content", "article", "main"];

export function parseSirionJd(html: string): string {
  const $ = cheerio.load(html);
  for (const sel of JD_SELECTORS) {
    const el = $(sel).first();
    if (el.length) {
      const t = htmlToText(el.html() ?? "");
      if (t.trim().length > 40) return t;
    }
  }
  return "";
}

let edgeBrowser: Browser | null = null;
let edgeBoot: Promise<Browser> | null = null;
let warmCtx: Promise<BrowserContext> | null = null;

async function getEdgeBrowser(): Promise<Browser> {
  if (edgeBrowser) return edgeBrowser;
  if (edgeBoot) return edgeBoot;
  edgeBoot = (async () => {
    logger.info("sirion: launching Edge (msedge channel) for the Akamai-fronted board");
    const b = await chromium.launch({ headless: true, channel: "msedge", args: ["--disable-blink-features=AutomationControlled"] });
    edgeBrowser = b;
    process.once("exit", () => { void b.close().catch(() => { /* already closed */ }); });
    return b;
  })();
  edgeBoot.catch(() => { edgeBoot = null; });
  return edgeBoot;
}

async function warmContext(): Promise<BrowserContext> {
  if (warmCtx) return warmCtx;
  warmCtx = (async () => {
    const browser = await getEdgeBrowser();
    const ctx = await browser.newContext({ locale: "en-US" });
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/careers/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(WAF_SETTLE_MS);
    await page.close();
    return ctx;
  })();
  warmCtx.catch(() => { warmCtx = null; });
  return warmCtx;
}

async function sirionFetch(url: string): Promise<string> {
  await awaitNetwork();
  const release = await acquirePageSlot();
  try {
    const ctx = await warmContext();
    const res = await ctx.request.get(url, { timeout: 45_000 });
    return await res.text();
  } finally {
    release();
  }
}

export const sirionAdapter: AtsAdapter = {
  provider: "sirion",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const out = new Map<string, NormalizedPosting>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = sirionListUrl(page);
      const rows = sirionPagePostings(company, url, await sirionFetch(url));
      if (rows.length === 0) break;
      const before = out.size;
      for (const r of rows) if (!out.has(r.externalId)) out.set(r.externalId, r);
      if (out.size === before) break;
    }
    logger.info({ company: company.slug, jobs: out.size }, "sirion: board crawled");
    return [...out.values()];
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await sirionFetch(posting.jobUrl);
    assertNotEdgeChallenge("sirion", posting.jobUrl, html);
    const loc = parseSirionJobLocation(html);
    if (loc) posting.location = loc;
    return parseSirionJd(html);
  },
};
