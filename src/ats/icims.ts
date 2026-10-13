// list: GET <host>/jobs/search?ss=1&in_iframe=1&pr=<N> (0-based; walk to the "Page X of N" header count)
// jd: description split across several .iCIMS_Expandable_Text sections inside .iCIMS_JobContent, concatenated
import * as cheerio from "cheerio";
import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { acquirePageSlot } from "../scraper/playwright.js";
import { awaitNetwork } from "../util/connectivity.js";
import { REMOTE_RE } from "./shared.js";
import { matchGroup } from "../util/regex.js";

const MAX_PAGES = 5000;
const WAF_SETTLE_MS = 10_000; // let the AWS WAF JS challenge solve + set cookies

export function icimsTenant(company: AdapterCompany): string {
  const url = company.tenantUrl ?? company.careersUrl;
  const host = new URL(url).hostname;
  if (!host.endsWith(".icims.com")) throw new Error(`icims: ${company.slug} is not on an *.icims.com host (${host})`);
  const token = host.slice(0, host.length - ".icims.com".length);
  if (token === "") throw new Error(`icims: empty tenant token for ${company.slug}`);
  return token;
}

function icimsOrigin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

export function icimsSearchUrl(origin: string, pr: number): string {
  return `${origin}/jobs/search?ss=1&in_iframe=1&pr=${pr}`;
}

function cleanJobUrl(href: string): string {
  try {
    const u = new URL(href);
    u.search = "";
    return u.toString();
  } catch {
    return href.split("?")[0] ?? href;
  }
}

export function icimsPageCount(html: string): number | null {
  const n = matchGroup(/Page\s+\d+\s+of\s+(\d+)/i, cheerio.load(html)(".iCIMS_SubHeader_Jobs").first().text());
  return n === null ? null : Number(n);
}

const LOCATION_LABEL_RE = /\bLocations?\b/i;

// Layouts differ per tenant (header slot vs additionalFields dl; "Job Locations", "Location : Location", "Additional Locations"), so find values by label.
function cardLocation($: cheerio.CheerioAPI, row: ReturnType<cheerio.CheerioAPI>): string | null {
  const parts: string[] = [];
  row.find(".field-label").each((_i, el) => {
    const label = $(el);
    if (!LOCATION_LABEL_RE.test(label.text())) return;
    const dt = label.closest("dt");
    const value = dt.length > 0 ? dt.next("dd").find("span").first() : label.siblings("span").not(".sr-only").first();
    for (const part of value.text().split(" | ")) {
      const p = part.trim();
      // "IN-Chennai" / "IND-KA-Bangalore" carry India only as an ISO code the location filter can't read
      if (p !== "") parts.push(/^IND?-/.test(p) ? `${p}, India` : p);
    }
  });
  return parts.length > 0 ? parts.join(" | ") : null;
}

export function parseIcimsList(html: string, company: AdapterCompany): NormalizedPosting[] {
  const $ = cheerio.load(html);
  const jobs: NormalizedPosting[] = [];
  $("li.iCIMS_JobCardItem").each((_i, li) => {
    const row = $(li);
    const link = row.find(".col-xs-12.title a").first();
    const href = link.attr("href");
    if (href === undefined) return;
    const externalId = matchGroup(/\/jobs\/(\d+)\//, href);
    if (externalId === null) return;
    const title = row.find(".col-xs-12.title h3").first().text().trim();
    const location = cardLocation($, row);
    jobs.push({
      provider: "icims",
      externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: cleanJobUrl(href),
      location,
      isRemote: REMOTE_RE.test(`${location ?? ""} ${title}`),
      jdText: "",
      postedAt: null,
    });
  });
  return jobs;
}

export function parseIcimsJd(html: string): string {
  const $ = cheerio.load(html);
  const sections = $(".iCIMS_JobContent .iCIMS_Expandable_Text");
  if (sections.length > 0) {
    return sections
      .map((_i, el) => htmlToText($(el).html() ?? ""))
      .toArray()
      .filter((t) => t !== "")
      .join("\n\n");
  }
  return htmlToText($(".iCIMS_JobContent").first().html() ?? "");
}

let edgeBrowser: Browser | null = null;
let edgeBoot: Promise<Browser> | null = null;
const warmContexts = new Map<string, Promise<BrowserContext>>();

// AWS WAF 405s bundled Chromium (and non-Edge UAs) with a "Human Verification" interstitial; msedge channel clears it.
async function getEdgeBrowser(): Promise<Browser> {
  if (edgeBrowser) return edgeBrowser;
  if (edgeBoot) return edgeBoot;
  edgeBoot = (async () => {
    logger.info("icims: launching Edge (msedge channel) for the AWS-WAF portal");
    const b = await chromium.launch({ headless: true, channel: "msedge", args: ["--disable-blink-features=AutomationControlled"] });
    edgeBrowser = b;
    const teardown = async (): Promise<void> => {
      try { await b.close(); } catch { /* already closed */ }
      edgeBrowser = null; edgeBoot = null; warmContexts.clear();
    };
    process.once("exit", () => { void teardown(); });
    return b;
  })();
  // A failed launch must not poison future calls: clear the cached promise so the next call retries.
  edgeBoot.catch(() => { edgeBoot = null; });
  return edgeBoot;
}

async function warmContext(origin: string): Promise<BrowserContext> {
  const existing = warmContexts.get(origin);
  if (existing) return existing;
  const created = (async () => {
    const browser = await getEdgeBrowser();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${origin}/jobs/search?ss=1`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(WAF_SETTLE_MS);
    await page.close();
    return ctx;
  })();
  // Drop a failed warm-up so a later call re-clears the WAF instead of reusing the rejected promise.
  created.catch(() => { warmContexts.delete(origin); });
  warmContexts.set(origin, created);
  return created;
}

async function icimsFetch(origin: string, url: string): Promise<string> {
  await awaitNetwork();
  const release = await acquirePageSlot();
  try {
    const ctx = await warmContext(origin);
    const res = await ctx.request.get(url, { timeout: 45_000 });
    return await res.text();
  } finally {
    release();
  }
}

export const icimsAdapter: AtsAdapter = {
  provider: "icims",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    icimsTenant(company);
    const origin = icimsOrigin(company);
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (let pr = 0; pr < MAX_PAGES; pr++) {
      const html = await icimsFetch(origin, icimsSearchUrl(origin, pr));
      const rows = parseIcimsList(html, company);
      for (const r of rows) {
        if (seen.has(r.externalId)) continue;
        seen.add(r.externalId);
        out.push(r);
      }
      // Page size varies (20, 37) and mid-board pages run short, so only the header's page count says when to stop.
      const pages = icimsPageCount(html);
      if (pages === null ? rows.length === 0 : pr + 1 >= pages) break;
    }
    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    // The JD may live on a different *.icims.com subdomain than the search host (franchisee boards), so warm the WAF for the job URL's own origin.
    const origin = new URL(posting.jobUrl).origin;
    const url = posting.jobUrl.includes("?") ? `${posting.jobUrl}&in_iframe=1` : `${posting.jobUrl}?in_iframe=1`;
    const html = await icimsFetch(origin, url);
    const jd = parseIcimsJd(html);
    if (jd === "") {
      logger.warn({ company: company.slug, job: posting.externalId }, "icims: job page had no iCIMS_JobContent");
    }
    return jd;
  },
};
