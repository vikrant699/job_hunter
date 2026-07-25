// src/ats/metacareers.ts — Meta careers site (metacareers.com), backed by the
// Comet/Relay GraphQL API the SPA itself calls (POST /graphql). A single
// global tenant (not multi-tenant like Workday) — company.careersUrl/slug are
// used only for normalization, not to build the request.
//
// Anonymous (logged-out) requests need only an `lsd` token (no `fb_dtsg` —
// confirmed live: the site's own outgoing POST bodies carry no fb_dtsg field
// at all when isLoggedIn:false) plus a persisted-query `doc_id`. Both the
// `lsd` token and the `doc_id` rotate with Meta's client build, so neither is
// hardcoded here: we load the plain careers page in a real browser, let its
// own JS fire its own GraphQL queries, and read the doc_id/lsd straight off
// those live requests (`discoverSearchContext`). If Meta renames or removes
// either query this throws a descriptive error instead of silently returning
// nothing — see the two "could not capture" errors below.
//
// The office-picker ("India") is not itself a valid `offices` filter value —
// live testing showed offices:["India"] returns zero results. The real filter
// values are city-slugs (e.g. "bangalore", "gurgaon"). Rather than hardcode
// that list we read it off the CareersJobSearchLocationFilterV3Query response
// (also captured from the natural page load) and select every entry whose
// `country` is "India".
//
// Job detail pages (/jobs/<id>/) are WAF-gated the same as the GraphQL
// endpoint (plain `fetch()` gets a generic 400 error page) but the full JD
// ships inline as a schema.org JobPosting <script type="application/ld+json">
// block in the server-rendered HTML — present already at `domcontentloaded`,
// no JS hydration wait needed.
import { z } from "zod";
import type { Request as PwRequest } from "playwright";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { REMOTE_RE } from "./shared.js";
import { logger } from "../logger.js";
import { matchGroup } from "../util/regex.js";

const JOBS_URL = "https://www.metacareers.com/jobs/";
const LOCATION_QUERY_NAME = "CareersJobSearchLocationFilterV3Query";
const RESULTS_QUERY_NAME = "CareersJobSearchResultsV2DataQuery";
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 4_000; // let the page's own queries land after networkidle
const HEAVY = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|css)(?:\?|$)/i;

/** Some FB GraphQL endpoints prefix the JSON body with this to block naive
 *  `<script>` inclusion. Not observed live for this endpoint, but stripped
 *  defensively since the behavior is documented Meta-wide. */
export function stripForLoopPrefix(text: string): string {
  const PREFIX = "for (;;);";
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
}

/** `JSON.parse` narrowed to `unknown` (not `any`) so callers must go through
 *  zod before touching any field — matches the JsonValue pattern elsewhere. */
function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text);
}

// ---- request/response capture ----

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

// ---- GraphQL response shapes ----

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

// ---- search-input variables (typed so page.evaluate's arg isn't `any`) ----

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

/**
 * Load the bare careers page in a real browser, capture the doc_id + lsd
 * token the page's OWN JS uses for the location-filter and job-search
 * GraphQL queries (self-healing against Meta's routine doc_id/lsd rotation),
 * read the India office ids off the (variable-less, always-full) location
 * response, then replay the job-search query in-page with those office ids.
 * Throws a descriptive error — never returns an empty list — if either query
 * can't be found, so a Meta-side rename surfaces loudly instead of looking
 * like "no India jobs".
 */
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
      HEAVY.test(route.request().url()) ? route.abort() : route.continue());
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
        // Fire-and-forget: response bodies land asynchronously; the
        // SETTLE_MS wait below gives them time before we read `calls`.
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

      const locationParsed = LocationFilterResponseSchema.safeParse(
        parseJsonUnknown(stripForLoopPrefix(locationCall.body)),
      );
      if (!locationParsed.success) {
        throw new Error(
          `metacareers: location-filter response schema mismatch: ` +
          `${JSON.stringify(locationParsed.error.issues.slice(0, 2))}`,
        );
      }
      const indiaOffices = locationParsed.data.data.job_search_filters.locations
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

      const resultsParsed = SearchResultsResponseSchema.safeParse(parseJsonUnknown(stripForLoopPrefix(raw)));
      if (!resultsParsed.success) {
        logger.warn({ issues: resultsParsed.error.issues.slice(0, 2) }, "metacareers search-results schema mismatch");
        throw new Error(
          `metacareers: search-results response schema mismatch: ` +
          `${JSON.stringify(resultsParsed.error.issues.slice(0, 2))}`,
        );
      }
      return resultsParsed.data.data.job_search_with_featured_jobs_v2.all_jobs;
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
    // The search result carries no JD — fetchJd fills this in. No date field
    // exists on the search result either (only the detail page's JSON-LD has
    // datePosted, and the AtsAdapter contract has no hook to backfill
    // postedAt from fetchJd), so postedAt stays null for every metacareers
    // posting — a known, documented limitation rather than an oversight.
    jdText: "",
    postedAt: null,
  };
}

// ---- job-detail JSON-LD (JD) extraction ----

const JobPostingLdSchema = z.object({
  "@type": z.string().optional(),
  description: z.string().nullable().optional(),
  responsibilities: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
});

/** Pull the `JobPosting` schema.org block out of a metacareers job-detail
 *  page's server-rendered HTML and flatten it into plain-text JD. Returns ""
 *  (not a throw) on any parse/shape failure — matches how other adapters
 *  degrade a single bad JD without failing the whole company's fetch. */
export function extractMetaJd(html: string): string {
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonUnknown(raw);
    } catch {
      continue;
    }
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
        HEAVY.test(route.request().url()) ? route.abort() : route.continue());
      try {
        const page = await ctx.newPage();
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        const url = `${JOBS_URL}${encodeURIComponent(posting.externalId)}/`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        const html = await page.content();
        return extractMetaJd(html);
      } finally {
        await ctx.close();
      }
    } finally {
      release();
    }
  },
};
