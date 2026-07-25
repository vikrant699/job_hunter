// src/ats/adityabirla.ts — Aditya Birla Group shared GROUP careers board
// (careers.adityabirla.com, Next.js). One JSON API serves every business unit
// (Cement/UltraTech, Financial Services, Fashion & Retail, Metals, ...):
//   GET /api/v3/jobs?orgunit=<OrgUnit>&offset=<page>&limit=<N>
//   -> { status: 200, count: <items returned this call>, data: [...] }
// `orgunit` must match one of the names the site itself exposes at
// /api/v3/organisations (e.g. "Cement", "Financial Services", "Metals",
// "Cellulosic Fibre & Textiles", "Chemicals", "Carbon Black", "Digital
// Platforms", "Renewables", "Paints", "Fashion & Retail", "Mining", "Century
// Group" — captured live 2026-07-11).
//
// Auth: every call carries an `Authorization: Bearer <token>` header that the
// site's own client JS attaches (there's no visible token/login endpoint —
// the SPA just has it). A bare curl without that header 401s, which is what
// makes this look session-bound, but once the header is present a plain node
// fetch succeeds with NO cookies at all. The token was observed byte-identical
// across several fresh, cookie-less browser contexts, so it reads as a
// build-time API key rather than a per-visitor session token — but we still
// *capture* it live from the page's own first API request (instead of
// hardcoding the observed value) and refresh+retry once on a 401, in case it
// ever does rotate.
//
// Pagination gotcha (confirmed live): `offset` is a 0-based PAGE NUMBER, not
// an item offset — offset=0..4 at limit=20 covers a from an 89-job org unit as
// items 1-20, 21-40, ..., 81-89 (not 0-19, 20-39, ...). `count` in the
// response is just "items returned this call", not a running/grand total, so
// pagination end is detected the same way as everywhere else here: a
// short/empty page.
//
// The site is fronted by an AppTrana WAF that 406s traffic it decides looks
// automated (independent of the bearer token) — the paginated fetches carry a
// browser UA and go out at the shared adapter pacing for that reason.
//
// The list response already carries the full `jobDescription` HTML inline —
// no separate detail endpoint is needed (`jobDetailUrl` is empty on every
// record observed, so `jobUrl` falls back to the shared listing page, same as
// the happyeasygo SPA-with-no-per-job-routes case).
import { z } from "zod";
import type { Request as PlaywrightRequest } from "playwright";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsHttpError, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { withBrowserPage } from "./browser-fetch.js";
import { config } from "../config.js";

const TENANT_ORIGIN = "https://careers.adityabirla.com";
const JOB_SEARCH_URL = `${TENANT_ORIGIN}/job-search`;
const JOBS_API_PATH = "/api/v3/jobs";
const PAGE_SIZE = 100;
// Tokens observed static across fresh contexts; re-check well before any
// plausible rotation window rather than trusting it for a whole long run.
const TOKEN_TTL_MS = 20 * 60 * 1000;

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

/**
 * Capture the SPA's bearer token by visiting /job-search once and reading the
 * Authorization header off the first request the page's own JS fires against
 * the jobs API — mirrors the site's real client rather than replaying a
 * separately-derived secret.
 */
async function captureAuthToken(): Promise<string> {
  // Boxed in an object: a bare `let token` mutated only inside the
  // `beforeGoto`-registered listener closure defeats TS's narrowing (it
  // can't see the reassignment from the outer scope and treats `token` as
  // permanently `null`); a property write is narrowed correctly at each
  // read below.
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

/** Build the paged jobs-API URL. `page` is a 0-based PAGE NUMBER (see module doc). */
export function adityaBirlaPageUrl(orgunit: string, page: number, pageSize: number = PAGE_SIZE): string {
  return `${TENANT_ORIGIN}${JOBS_API_PATH}?orgunit=${encodeURIComponent(orgunit)}&offset=${page}&limit=${pageSize}`;
}

async function fetchJobsPage(orgunit: string, page: number, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(adityaBirlaPageUrl(orgunit, page), {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 401) throw new AuthExpiredError();
    if (!res.ok) throw atsHttpError("adityabirla", res.status, await res.text());
    return await res.json();
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
    // jobDetailUrl is empty on every record observed — this SPA has no working
    // per-job route, so every posting falls back to the shared listing page.
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
    // Explicit `string` annotation (not just the narrowed `const`) so the type
    // holds across the nested closure below — TS control-flow narrowing from
    // the guard above doesn't cross function boundaries on its own.
    const orgunit: string = orgunitMeta;

    let token = await getAuthToken(false);

    async function fetchPageWithRetry(page: number): Promise<unknown> {
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
