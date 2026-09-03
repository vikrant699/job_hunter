// list: GET /api/v3/jobs?orgunit=<OrgUnit>&offset=<page>&limit=<N> -> {data[]}; orgunit must match a name from /api/v3/organisations
// jd: jobDescription HTML is inline in the list - no detail endpoint; jobUrl falls back to the shared listing page since jobDetailUrl is always empty
import { z } from "zod";
import type { Request as PlaywrightRequest } from "playwright";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsHttpError, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { withBrowserPage } from "./browserFetch.js";
import { config } from "../config.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

const TENANT_ORIGIN = "https://careers.adityabirla.com";
const JOB_SEARCH_URL = `${TENANT_ORIGIN}/job-search`;
const JOBS_API_PATH = "/api/v3/jobs";
const PAGE_SIZE = 100;
const TOKEN_TTL_MS = 20 * 60 * 1000; // token observed static; re-check well before any plausible rotation

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  jobTitle: z.string().nullable().optional(),
  designation: z.string().nullable().optional(),
  organizationUnit: z.string().nullable().optional(),
  organizationUnitComplete: z.string().nullable().optional(),
  locationHierarchyComplete: z.string().nullable().optional(),
  locationHierarchy: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  jobPostedDate: z.string().nullable().optional(),
  jobDetailUrl: z.string().nullable().optional(),
});
export type AdityaBirlaJob = z.infer<typeof JobSchema>;

const ListSchema = z.object({
  status: z.number().nullable().optional(),
  count: z.number().nullable().optional(),
  data: z.array(JobSchema),
});

class AuthExpiredError extends Error {
  constructor() {
    super("adityabirla: bearer token expired (401)");
    this.name = "AdityaBirlaAuthExpiredError";
  }
}

let cachedToken: { value: string; fetchedAt: number } | null = null;

// There is no login endpoint for this bearer token: it can only be sniffed from the SPA's own XHRs (AppTrana WAF also requires a browser UA), then reused until a 401 forces recapture.
async function captureAuthToken(): Promise<string> {
  // Boxed in an object: TS narrowing can't see a `let` reassigned only inside the beforeGoto closure below.
  const captured: { token: string | null } = { token: null };
  let onRequest: ((req: PlaywrightRequest) => void) | null = null;
  return withBrowserPage(
    JOB_SEARCH_URL,
    async (page) => {
      for (let i = 0; i < 10 && !captured.token; i++) await page.waitForTimeout(500);
      if (onRequest) page.off("request", onRequest);
      if (!captured.token) throw new Error("adityabirla: could not capture bearer token from /job-search");
      return captured.token;
    },
    {
      blockHeavyAssets: false,
      waitUntil: "networkidle", // WAF interstitial or slow settle is swallowed (default); token may still arrive below
      settleMs: 0, // the poll loop above replaces the fixed settle wait
      beforeGoto: (page) => {
        onRequest = (req: PlaywrightRequest): void => {
          if (captured.token) return;
          if (!req.url().includes(JOBS_API_PATH) && !req.url().includes("/api/v3/organisations")) return;
          const auth = req.headers()["authorization"];
          if (auth && auth.startsWith("Bearer ")) captured.token = auth.slice("Bearer ".length);
        };
        page.on("request", onRequest);
      },
    },
  );
}

async function getAuthToken(forceRefresh: boolean): Promise<string> {
  if (!forceRefresh && cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS) {
    return cachedToken.value;
  }
  const value = await captureAuthToken();
  cachedToken = { value, fetchedAt: Date.now() };
  return value;
}

// `page` is a 0-based PAGE NUMBER, not an item offset
export function adityaBirlaPageUrl(orgunit: string, page: number, pageSize: number = PAGE_SIZE): string {
  return `${TENANT_ORIGIN}${JOBS_API_PATH}?orgunit=${encodeURIComponent(orgunit)}&offset=${page}&limit=${pageSize}`;
}

async function fetchJobsPage(orgunit: string, page: number, token: string): Promise<JsonValue> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(adityaBirlaPageUrl(orgunit, page), {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401) throw new AuthExpiredError();
    if (!res.ok) throw atsHttpError("adityabirla", res.status, await res.text());
    return JsonValueSchema.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeAdityaBirla(company: AdapterCompany, j: AdityaBirlaJob): NormalizedPosting {
  const location = j.locationHierarchyComplete ?? j.locationHierarchy ?? null;
  const title = (j.jobTitle && j.jobTitle.trim()) || (j.designation && j.designation.trim()) || "";
  const postedMs = j.jobPostedDate ? Date.parse(j.jobPostedDate) : Number.NaN;
  return {
    provider: "adityabirla",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: (j.jobDetailUrl && j.jobDetailUrl.trim()) || JOB_SEARCH_URL,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.jobDescription),
    postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
  };
}

export const adityabirlaAdapter: AtsAdapter = {
  provider: "adityabirla",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const orgunitMeta = company.apiMeta?.orgunit;
    if (!orgunitMeta) throw new Error(`adityabirla: company ${company.slug} is missing apiMeta.orgunit`);
    // Explicit annotation: narrowing doesn't cross into the closure below.
    const orgunit: string = orgunitMeta;

    let token = await getAuthToken(false);

    async function fetchPageWithRetry(page: number): Promise<JsonValue> {
      try {
        return await fetchJobsPage(orgunit, page, token);
      } catch (err) {
        if (!(err instanceof AuthExpiredError)) throw err;
        token = await getAuthToken(true);
        return await fetchJobsPage(orgunit, page, token);
      }
    }

    return paginate<NormalizedPosting>({
      provider: "adityabirla",
      company: company.slug,
      pageSize: PAGE_SIZE,
      fetchPage: async (_offset, page) => {
        const raw = await fetchPageWithRetry(page);
        const parsed = parseOrThrow(ListSchema, raw, { provider: "adityabirla", slug: company.slug, what: `page ${page}` });
        return {
          items: parsed.data.map((j) => normalizeAdityaBirla(company, j)),
          total: null,
          rawCount: parsed.data.length,
        };
      },
    });
  },
  // The list response carries the full jobDescription HTML — no fetchJd needed.
};
