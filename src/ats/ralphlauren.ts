// src/ats/ralphlauren.ts — Ralph Lauren careers = Avature's React SPA portal
// (careers.ralphlauren.com) behind Cloudflare bot-management; a plain fetch gets HTTP 202 + empty
// body, so we clear Cloudflare in the shared headless browser and run the board's JSON API in-page.
// GET /en_US/CareersCorporate/SearchJobsCorporateData/ returns every job in one call, grouped by
// location, but location comes only as lat/lon and many India jobs land in an ungeocoded "," bucket
// with no country field. We emit geocoded-India jobs with a concrete location, skip geocoded-foreign
// ones, and emit the ambiguous bucket with location=null so the pipeline's JD-based filter decides.
// There is no server-side location filter — every guessed param returns all jobs.
import * as cheerio from "cheerio";
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { browserFetchJson, withBrowserPage } from "./browserFetch.js";
import { htmlToText } from "./htmlText.js";
import { parseOrThrow } from "./http.js";
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

// The true location of an ungeocoded posting, read from the labelled City/State/Region/Location
// fields in the job-detail page's first article--details block. This is the only place a real
// location exists for the "," bucket, so fetchJd resolves it there and the pipeline re-applies the
// strict check (lateLocationCheck) — otherwise a foreign role reaches the LLM gate as unknown-defer.
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
    const parsed = parseOrThrow(DataSchema, raw ?? null, { provider: "ralphlauren", slug: company.slug });
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const loc of Object.values(parsed.locations)) {
      const latlon = (loc.latlon ?? "").trim();
      const ungeocoded = latlon === "" || latlon === ",";
      const city = ungeocoded ? null : indiaCityFromLatlon(latlon);
      // Geocoded but not India: confirmed foreign, skip. Ungeocoded: keep with location=null.
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

  // Also resolves posting.location for the ungeocoded bucket — see ralphLaurenDetailLocation.
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    // React-hydrated content: an XHR returns an empty shell, so navigate and read the rendered DOM.
    return withBrowserPage(
      posting.jobUrl,
      async (page) => {
        try {
          await page.waitForSelector("article.article--details", { timeout: 20_000 });
        } catch { /* fall through: parse whatever rendered */ }
        await page.waitForTimeout(1500);
        const html = await page.content();
        // Backfill the location the list API couldn't give us.
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
      },
      { navTimeoutMs: 45_000, settleMs: 0, blockHeavyAssets: false },
    );
  },
};
