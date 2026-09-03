// GraphQL POST to metacareers.com/graphql (Comet/Relay); lsd token + persisted-query doc_id rotate with Meta's build, so they're captured live off the page's own requests rather than hardcoded
// offices filter values are India city-slugs read from CareersJobSearchLocationFilterV3Query (the "India" picker label itself returns zero results); job detail pages carry full JD inline as JSON-LD
import { z } from "zod";
import type { Request as PwRequest } from "playwright";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { withBrowserPage, HEAVY_ASSET_RE } from "./browserFetch.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE } from "./shared.js";
import { parseOrThrow } from "./http.js";
import { matchGroup } from "../util/regex.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

const JOBS_URL = "https://www.metacareers.com/jobs/";
const LOCATION_QUERY_NAME = "CareersJobSearchLocationFilterV3Query";
const RESULTS_QUERY_NAME = "CareersJobSearchResultsV2DataQuery";
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 4_000; // let the page's own queries land after networkidle

// Some FB GraphQL endpoints prefix the JSON body with this to block naive <script> inclusion.
export function stripForLoopPrefix(text: string): string {
  const PREFIX = "for (;;);";
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
}

function parseJsonUnknown(text: string): JsonValue {
  return JsonValueSchema.parse(JSON.parse(text));
}

interface GraphqlCall {
  friendlyName: string | null;
  docId: string | null;
  lsd: string | null;
  body: string | null;
}

export function parsePostData(postData: string | null): Omit<GraphqlCall, "body"> {
  if (!postData) return { friendlyName: null, docId: null, lsd: null };
  const fn = matchGroup(/fb_api_req_friendly_name=([^&]+)/, postData);
  const di = matchGroup(/doc_id=(\d+)/, postData);
  const lsdM = matchGroup(/(?:^|&)lsd=([^&]+)/, postData);
  return {
    friendlyName: fn ? decodeURIComponent(fn) : null,
    docId: di,
    lsd: lsdM ? decodeURIComponent(lsdM) : null,
  };
}

export const LocationEntrySchema = z.object({
  id: z.string(),
  country: z.string().nullable().optional(),
});

export const LocationFilterResponseSchema = z.object({
  data: z.object({
    job_search_filters: z.object({
      locations: z.array(LocationEntrySchema),
    }),
  }),
});

export const MetaJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  locations: z.array(z.string()).nullable().optional(),
  teams: z.array(z.string()).nullable().optional(),
  sub_teams: z.array(z.string()).nullable().optional(),
});
export type MetaJob = z.infer<typeof MetaJobSchema>;

export const SearchResultsResponseSchema = z.object({
  data: z.object({
    job_search_with_featured_jobs_v2: z.object({
      all_jobs: z.array(MetaJobSchema),
    }),
  }),
});

interface MetaSearchInput {
  q: null;
  divisions: string[];
  offices: string[];
  roles: string[];
  leadership_levels: string[];
  saved_jobs: string[];
  saved_searches: string[];
  sub_teams: string[];
  teams: string[];
  is_leadership: boolean;
  is_remote_only: boolean;
  sort_by_new: boolean;
  results_per_page: null;
}
interface MetaSearchVariables {
  search_input: MetaSearchInput;
  viewasUserID: null;
  isLoggedIn: boolean;
}
interface RunSearchArgs {
  docId: string;
  lsd: string;
  friendlyName: string;
  variables: MetaSearchVariables;
}

export function indiaSearchVariables(offices: string[]): MetaSearchVariables {
  return {
    search_input: {
      q: null, divisions: [], offices, roles: [], leadership_levels: [],
      saved_jobs: [], saved_searches: [], sub_teams: [], teams: [],
      is_leadership: false, is_remote_only: false, sort_by_new: false,
      results_per_page: null,
    },
    viewasUserID: null,
    isLoggedIn: false,
  };
}

export async function fetchIndiaJobs(): Promise<MetaJob[]> {
  const release = await acquirePageSlot();
  try {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "Asia/Kolkata",
    });
    await ctx.route("**/*", (route) =>
      HEAVY_ASSET_RE.test(route.request().url()) ? route.abort() : route.continue());
    try {
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

      const calls = new Map<PwRequest, GraphqlCall>();
      page.on("request", (req) => {
        if (!req.url().includes("/graphql")) return;
        calls.set(req, { ...parsePostData(req.postData()), body: null });
      });
      page.on("response", (res) => {
        const call = calls.get(res.request());
        if (!call) return;
        // fire-and-forget: response bodies land asynchronously; SETTLE_MS below gives them time before we read `calls`
        res.text().then((body) => { call.body = body; }).catch(() => { /* page closed mid-read */ });
      });

      try {
        await page.goto(JOBS_URL, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      } catch {
        await page.goto(JOBS_URL, { waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(() => { /* best effort */ });
      }
      await page.waitForTimeout(SETTLE_MS);

      const captured = [...calls.values()];
      const locationCall = captured.find((c) => c.friendlyName === LOCATION_QUERY_NAME && c.body);
      const resultsCall = captured.find((c) => c.friendlyName === RESULTS_QUERY_NAME && c.docId && c.lsd);

      if (!locationCall?.body) {
        throw new Error(
          `metacareers: could not capture ${LOCATION_QUERY_NAME} response — ` +
          "Meta may have renamed/removed the location-filter query",
        );
      }
      if (!resultsCall?.docId || !resultsCall.lsd) {
        throw new Error(
          `metacareers: could not capture ${RESULTS_QUERY_NAME} doc_id/lsd — ` +
          "Meta may have renamed/removed the job-search query",
        );
      }

      const locationParsed = parseOrThrow(
        LocationFilterResponseSchema,
        parseJsonUnknown(stripForLoopPrefix(locationCall.body)),
        { provider: "metacareers", slug: "metacareers", what: "location-filter" },
      );
      const indiaOffices = locationParsed.data.job_search_filters.locations
        .filter((l) => l.country === "India")
        .map((l) => l.id);
      if (indiaOffices.length === 0) {
        throw new Error("metacareers: no India office ids found in location-filter response");
      }

      const args: RunSearchArgs = {
        docId: resultsCall.docId,
        lsd: resultsCall.lsd,
        friendlyName: RESULTS_QUERY_NAME,
        variables: indiaSearchVariables(indiaOffices),
      };
      const raw = await page.evaluate(async (a: RunSearchArgs): Promise<string> => {
        const body = new URLSearchParams({
          lsd: a.lsd,
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: a.friendlyName,
          server_timestamps: "true",
          variables: JSON.stringify(a.variables),
          doc_id: a.docId,
        });
        const res = await fetch("/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" },
          body: body.toString(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      }, args);

      const resultsParsed = parseOrThrow(SearchResultsResponseSchema, parseJsonUnknown(stripForLoopPrefix(raw)), {
        provider: "metacareers",
        slug: "metacareers",
        what: "search-results",
      });
      return resultsParsed.data.job_search_with_featured_jobs_v2.all_jobs;
    } finally {
      await ctx.close();
    }
  } finally {
    release();
  }
}

export function normalizeMetaJob(company: AdapterCompany, j: MetaJob): NormalizedPosting {
  const location = j.locations && j.locations.length > 0 ? j.locations.join("; ") : null;
  return {
    provider: "metacareers",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${JOBS_URL}${j.id}/`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    // The search result carries no JD or date field; fetchJd fills the JD, postedAt stays null.
    jdText: "",
    postedAt: null,
  };
}

const JobPostingLdSchema = z.object({
  "@type": z.string().optional(),
  description: z.string().nullable().optional(),
  responsibilities: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
});

export function extractMetaJd(html: string): string {
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    const parsed = tryParseJson(raw);
    if (parsed === null) continue;
    const result = JobPostingLdSchema.safeParse(parsed);
    if (!result.success || result.data["@type"] !== "JobPosting") continue;
    const { description, responsibilities, qualifications } = result.data;
    const parts = [
      description ?? null,
      responsibilities ? `Responsibilities\n${responsibilities}` : null,
      qualifications ? `Minimum Qualifications\n${qualifications}` : null,
    ].filter((p): p is string => p !== null);
    return htmlToText(parts.join("\n\n"));
  }
  return "";
}

export const metacareersAdapter: AtsAdapter = {
  provider: "metacareers",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const jobs = await fetchIndiaJobs();
    return jobs.map((j) => normalizeMetaJob(company, j));
  },
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const url = `${JOBS_URL}${encodeURIComponent(posting.externalId)}/`;
    return withBrowserPage(
      url,
      async (page) => {
        const html = await page.content();
        return extractMetaJd(html);
      },
      // unlike fetchIndiaJobs, this route has no observed CF interstitial; no goto catch/settle, rethrow + settleMs:0 preserved as-is
      { settleMs: 0, rethrowGotoErrors: true },
    );
  },
};
