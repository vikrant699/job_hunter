// src/ats/ralphlauren.ts — Ralph Lauren careers = Avature's new React SPA portal
// (careers.ralphlauren.com) behind Cloudflare bot-management. A plain server-side
// fetch gets HTTP 202 + empty body; only a real browser (with the cf cookie) gets
// through — so we clear Cloudflare in the shared headless browser, then run the
// board's own JSON API in-page (the ubs/bmw/reliancebrands pattern).
//
// Corporate/tech board list (one call, no pagination, returns ALL jobs):
//   GET /en_US/CareersCorporate/SearchJobsCorporateData/
//     -> { locations: { "<id>": { title, latlon:"lat,lon", jobs:[{id,title,url}] } }, totalCount }
// Location comes only as lat/lon (titles are empty). Avature geocodes SOME jobs
// (Bangalore = 12.97,77.59) but dumps others — including real India roles like the
// commerce-platform FE developer — into an empty "," bucket with NO country field.
// So we can't filter India from the list alone. We therefore:
//   - emit geocoded-India jobs with a concrete location (fast path),
//   - emit the ambiguous "," bucket with location=null so the pipeline's built-in
//     JD-based location filter (checkLocationFromText) decides — title-deny drops
//     most non-SWE roles BEFORE any JD fetch, so this stays cheap in practice,
//   - skip geocoded-foreign jobs (confirmed not India).
// There is no server-side location filter — every guessed param returns all jobs.
//
// JD: server-rendered HTML at JobDetailCorporate?jobId=N (also Cloudflare-gated);
// the job content lives in the page's <article>.
import * as cheerio from "cheerio";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { browserFetchJson } from "./browser-fetch.js";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { REMOTE_RE } from "./shared.js";

const HOST = "https://careers.ralphlauren.com";
const SEARCH_PAGE = `${HOST}/en_US/CareersCorporate/SearchJobsCorporate`;
const DATA_URL = `${HOST}/en_US/CareersCorporate/SearchJobsCorporateData/`;

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  url: z.string(),
});
const LocationSchema = z.object({
  title: z.string().nullable().optional(),
  latlon: z.string().nullable().optional(),
  jobs: z.array(JobSchema).nullable().optional(),
});
const DataSchema = z.object({
  locations: z.record(LocationSchema),
  totalCount: z.union([z.number(), z.string()]).nullable().optional(),
});

/** Map an Avature "lat,lon" to an India location string, or null if not in India. */
export function indiaCityFromLatlon(latlon: string | null | undefined): string | null {
  if (!latlon) return null;
  const parts = latlon.split(",");
  const lat = Number((parts[0] ?? "").trim());
  const lon = Number((parts[1] ?? "").trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // India bounding box (rough): lat 6–36 N, lon 68–98 E.
  if (lat <= 6 || lat >= 36 || lon <= 68 || lon >= 98) return null;
  // Only Bangalore observed so far; refine if other India hubs appear.
  if (lat > 12.8 && lat < 13.2 && lon > 77.3 && lon < 77.9) return "Bengaluru, India";
  return "India";
}

export function normalizeRalphLauren(
  company: AdapterCompany,
  job: z.infer<typeof JobSchema>,
  location: string | null,
): NormalizedPosting {
  return {
    provider: "ralphlauren",
    externalId: String(job.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: job.title,
    jobUrl: job.url,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: null,
  };
}

/**
 * The true location of an ungeocoded posting, read from the labelled fields in
 * the job-detail page's first `article--details` block (`City`, `State/Region`,
 * `Location` = country). Verified live 2026-07-25: an India role reads
 * "Bangalore / Karnataka / India", a Hong Kong one "Tsim Sha Tsui / Kowloon /
 * Hong Kong SAR".
 *
 * This is the only place a real location exists for the `","` bucket, and
 * `fetchJd` is the only pass that loads the detail page — so it resolves the
 * location there and the pipeline re-applies the strict check (see
 * `lateLocationCheck`). Without it a foreign role reaches the LLM gate as
 * "unknown-defer", since the flattened JD text has no `Location:` label line.
 */
export function ralphLaurenDetailLocation(html: string): string | null {
  if (!html.trim()) return null;
  const $ = cheerio.load(html);
  const fields = new Map<string, string>();
  $(".article__content__view__field").each((_i, el) => {
    const label = $(el).find(".article__content__view__field__label").first().text().trim();
    const value = $(el).find(".article__content__view__field__value").first().text().trim();
    if (label && value && !fields.has(label)) fields.set(label, value);
  });
  const parts = ["City", "State/Region", "Location"]
    .map((k) => fields.get(k))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

export const ralphlaurenAdapter: AtsAdapter = {
  provider: "ralphlauren",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const [raw] = await browserFetchJson(SEARCH_PAGE, [DATA_URL]);
    const parsed = DataSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "ralphlauren schema mismatch");
      throw new Error(`ralphlauren response failed schema for ${company.slug}`);
    }
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const loc of Object.values(parsed.data.locations)) {
      const latlon = (loc.latlon ?? "").trim();
      const ungeocoded = latlon === "" || latlon === ",";
      const city = ungeocoded ? null : indiaCityFromLatlon(latlon);
      // Geocoded but not India → confirmed foreign, skip. Ungeocoded → keep with
      // location=null so the pipeline's JD-based location filter decides.
      if (!ungeocoded && !city) continue;
      for (const job of loc.jobs ?? []) {
        const p = normalizeRalphLauren(company, job, city);
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
    }
    return out;
  },

  // Also resolves `posting.location` for the ungeocoded bucket — see
  // `ralphLaurenDetailLocation` and the AtsAdapter.fetchJd contract.
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    // The JobDetail content is React-hydrated — an XHR returns an empty shell, so
    // we navigate in the browser and read the rendered DOM. The JD lives in the
    // `article--details` blocks (metadata + company/overview/duties/experience);
    // the action/share/notification articles are skipped.
    const release = await acquirePageSlot();
    try {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 },
        locale: "en-US", timezoneId: "Asia/Kolkata",
      });
      try {
        const page = await ctx.newPage();
        page.setDefaultNavigationTimeout(45_000);
        try {
          await page.goto(posting.jobUrl, { waitUntil: "domcontentloaded" });
        } catch { /* CF interstitial — the wait below still resolves once hydrated */ }
        try {
          await page.waitForSelector("article.article--details", { timeout: 20_000 });
        } catch { /* fall through: parse whatever rendered */ }
        await page.waitForTimeout(1500);
        const html = await page.content();
        // Backfill the location the list API couldn't give us, so the pipeline
        // judges this posting on real metadata instead of deferring on text.
        if (!posting.location) {
          const resolved = ralphLaurenDetailLocation(html);
          if (resolved) posting.location = resolved;
        }
        const $ = cheerio.load(html);
        const parts = $("article.article--details")
          .map((_i, el) => htmlToText($.html(el)))
          .get()
          .map((s) => s.trim())
          .filter(Boolean);
        return parts.join("\n\n");
      } finally {
        await ctx.close();
      }
    } finally {
      release();
    }
  },
};
