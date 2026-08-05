// src/ats/webbtree.ts — Webbtree hosted career boards
// (app.webbtree.com/company/<slug>/jobs, e.g. ideaForge).
//
// STEP 1 (list): a plain GET of the board returns SSR HTML with the full,
// unpaginated job list as an Angular TransferState island:
//
//   <script id="serverApp-state" type="application/json">{...}</script>
//
// The island is a JSON object keyed by request URL, e.g.:
//   { "https://appapi.webbtree.com/candidate/jobs/getjobs": { url, body: { status, message: Job[] } },
//     "https://appapi.webbtree.com/candidate/company/getcompanyinfo?...&c_e=<token>": {...}, ... }
//
// It uses a CUSTOM entity scheme (not standard HTML entities): &q; -> ",
// &a; -> &. Must decode in a single pass BEFORE JSON.parse (a naive
// iterative/sequential replace would double-decode: an "&a;" that decodes to
// "&" must not be re-scanned as the start of a new entity).
//
// The tenant's opaque `c_e` token also lives in this island — either as a
// `c_e=` query param on the getcompanyinfo request URL, or (fallback) inside
// a job's `jobdescriptionurl` path segment
// (".../<slug>/<token>/job-board/career/jobdetail/<jobnumber>"). Needed for
// step 2; cached in-memory per company slug (or supplied via
// company.apiMeta.c_e, once registry seeding starts stashing it there).
//
// STEP 2 (JD, per job): POST to a SHARED endpoint (same host for every
// tenant) with the token in both the body and a `customurl` header:
//
//   POST https://appapi.webbtree.com/candidate/jobs/getjobdetails
//   body: { companynumber: "qwer23", jobnumber, candidatenumber: null,
//           c_n: <slug>, c_e: <token> }
//   header: customurl: /<slug>/<token>
//   -> { status, message: { details: { jobdescription: "<html>", ... } } }
//
// "qwer23" is a hardcoded placeholder the backend ignores (verified live) —
// not a real per-tenant company number. The island's `jobdescriptionurl`
// field is a dead legacy route (an Angular SPA route, not a fetchable JD
// endpoint) — never used for fetching, only as a human-facing job link.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText, parseOrThrow, parseOrNull } from "./http.js";
import { matchGroup } from "../util/regex.js";
import { tryParseJson, JsonValueSchema } from "../util/json.js";

const JOB_DETAILS_URL = "https://appapi.webbtree.com/candidate/jobs/getjobdetails";
// Backend-ignored placeholder — confirmed live; the real tenant identity travels via c_n/c_e.
const COMPANY_NUMBER_PLACEHOLDER = "qwer23";

export const WebbtreeJobSchema = z.object({
  jobnumber: z.string(),
  jobname: z.string(),
  functions: z.string().nullable().optional(),
  locationname: z.string().nullable().optional(),
  employmenttype: z.string().nullable().optional(),
  remotelocation: z.union([z.number(), z.boolean()]).nullable().optional(),
  jobdescriptionurl: z.string().nullable().optional(),
});
export type WebbtreeJob = z.infer<typeof WebbtreeJobSchema>;

const WebbtreeJobsResponseSchema = z.object({
  status: z.string().optional(),
  message: z.array(WebbtreeJobSchema),
});

const WebbtreeIslandEntrySchema = z
  .object({
    url: z.string().optional(),
    body: JsonValueSchema.optional(),
  })
  .passthrough();
const WebbtreeIslandSchema = z.record(z.string(), WebbtreeIslandEntrySchema);
export type WebbtreeIsland = z.infer<typeof WebbtreeIslandSchema>;

const WebbtreeJobDetailsResponseSchema = z.object({
  status: z.string().optional(),
  message: z
    .object({
      details: z
        .object({
          jobdescription: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Decode Webbtree's custom entity scheme in a single pass: &q; -> ", &a; ->
 * &. A combined regex + branching replacer (rather than two sequential
 * `.replace` calls) guarantees each occurrence is visited exactly once, so an
 * "&a;" that decodes to a literal "&" is never mistaken for the start of a
 * fresh entity in the same pass.
 */
export function decodeWebbtreeEntities(s: string): string {
  return s.replace(/&q;|&a;/g, (m) => (m === "&q;" ? '"' : "&"));
}

/** Pull the raw (still entity-escaped) contents of the serverApp-state
 *  TransferState island. Null when absent (WAF page, wrong path, layout change). */
export function extractServerAppStateIsland(html: string): string | null {
  return matchGroup(/<script id="serverApp-state" type="application\/json">([\s\S]*?)<\/script>/, html);
}

/** Entity-decode + JSON-parse + zod-validate the island. Throws with an
 *  actionable message on garbage (each failure mode named separately). */
export function parseServerAppState(raw: string, slug: string): WebbtreeIsland {
  const parsed = tryParseJson(decodeWebbtreeEntities(raw));
  if (parsed === null) {
    throw new Error(`webbtree serverApp-state island is not valid JSON for ${slug} (serialization change?)`);
  }
  return parseOrThrow(WebbtreeIslandSchema, parsed, { provider: "webbtree", slug, what: "serverApp-state island" });
}

function findIslandEntry(island: WebbtreeIsland, urlSubstring: string): WebbtreeIsland[string] | undefined {
  return Object.values(island).find((entry) => typeof entry.url === "string" && entry.url.includes(urlSubstring));
}

/** Pull the job list out of the island's getjobs entry. Throws when that
 *  entry is missing or its body doesn't match the expected shape. */
export function webbtreeJobsFromIsland(island: WebbtreeIsland, slug: string): WebbtreeJob[] {
  const entry = findIslandEntry(island, "/candidate/jobs/getjobs");
  if (!entry) {
    throw new Error(`webbtree: no getjobs entry in serverApp-state island for ${slug} — layout/route change`);
  }
  const parsed = parseOrThrow(WebbtreeJobsResponseSchema, entry.body ?? null, { provider: "webbtree", slug, what: "getjobs" });
  return parsed.message;
}

const CE_TOKEN_RE = /[?&]c_e=([A-Za-z0-9_-]+)/;
const CE_TOKEN_FROM_JOB_URL_RE = /\/([A-Za-z0-9_-]+)\/job-board\/career\/jobdetail\//;

/**
 * The tenant's opaque c_e token, tried in two places: any island entry's
 * request URL carrying a `c_e=` query param (getcompanyinfo, in practice),
 * falling back to the path segment embedded in a job's `jobdescriptionurl`.
 * Null when neither source has it (e.g. an empty board with no
 * getcompanyinfo call recorded).
 */
export function extractCeToken(island: WebbtreeIsland, jobs: readonly WebbtreeJob[]): string | null {
  for (const entry of Object.values(island)) {
    const token = typeof entry.url === "string" ? matchGroup(CE_TOKEN_RE, entry.url) : null;
    if (token) return token;
  }
  for (const j of jobs) {
    const token = j.jobdescriptionurl ? matchGroup(CE_TOKEN_FROM_JOB_URL_RE, j.jobdescriptionurl) : null;
    if (token) return token;
  }
  return null;
}

export function webbtreeListUrl(slug: string): string {
  return `https://app.webbtree.com/company/${slug}/jobs`;
}

export function normalizeWebbtree(company: AdapterCompany, j: WebbtreeJob): NormalizedPosting {
  const location = j.locationname
    ? j.locationname.split(",").map((s) => s.trim()).filter(Boolean).join(", ")
    : null;
  return {
    provider: "webbtree",
    externalId: j.jobnumber,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobname,
    jobUrl: j.jobdescriptionurl ?? webbtreeListUrl(company.slug),
    location,
    isRemote: j.remotelocation === 1 || j.remotelocation === true,
    // Two-phase: JD comes from fetchJd (getjobdetails), never inline in the list.
    jdText: "",
    postedAt: null,
  };
}

interface WebbtreeListParse {
  jobs: WebbtreeJob[];
  ceToken: string | null;
}

/** Full HTML -> {jobs, ceToken}. Exposed so listPostings and the token
 *  fallback path (resolveCeToken) share one parse. */
function parseWebbtreeListHtml(html: string, slug: string): WebbtreeListParse {
  const raw = extractServerAppStateIsland(html);
  if (raw === null) {
    throw new Error(
      `webbtree: no serverApp-state island at ${webbtreeListUrl(slug)} for ${slug} — wrong page path or layout change`,
    );
  }
  const island = parseServerAppState(raw, slug);
  const jobs = webbtreeJobsFromIsland(island, slug);
  return { jobs, ceToken: extractCeToken(island, jobs) };
}

/** Full HTML -> postings path, exposed so tests cover it without HTTP. */
export function postingsFromWebbtreeHtml(company: AdapterCompany, html: string): NormalizedPosting[] {
  const { jobs, ceToken } = parseWebbtreeListHtml(html, company.slug);
  if (ceToken) tokenCache.set(company.slug, ceToken);
  return jobs.map((j) => normalizeWebbtree(company, j));
}

// In-memory cache: listPostings always runs before fetchJd in the pipeline,
// so this normally spares fetchJd a second full-page fetch just for the
// token. Falls back to re-deriving from a fresh fetch if the cache (and
// apiMeta) are both empty — e.g. fetchJd called standalone.
const tokenCache = new Map<string, string>();

async function resolveCeToken(company: AdapterCompany): Promise<string> {
  if (company.apiMeta?.c_e) return company.apiMeta.c_e;
  const cached = tokenCache.get(company.slug);
  if (cached) return cached;
  const html = await atsFetchText(webbtreeListUrl(company.slug), { provider: "webbtree" });
  const { ceToken } = parseWebbtreeListHtml(html, company.slug);
  if (!ceToken) throw new Error(`webbtree: could not determine c_e token for ${company.slug}`);
  tokenCache.set(company.slug, ceToken);
  return ceToken;
}

export function webbtreeJdRequestBody(
  slug: string,
  jobnumber: string,
  ceToken: string,
): { companynumber: string; jobnumber: string; candidatenumber: null; c_n: string; c_e: string } {
  return { companynumber: COMPANY_NUMBER_PLACEHOLDER, jobnumber, candidatenumber: null, c_n: slug, c_e: ceToken };
}

export function webbtreeCustomUrlHeader(slug: string, ceToken: string): string {
  return `/${slug}/${ceToken}`;
}

export const webbtreeAdapter: AtsAdapter = {
  provider: "webbtree",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(webbtreeListUrl(company.slug), { provider: "webbtree" });
    return postingsFromWebbtreeHtml(company, html);
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const ceToken = await resolveCeToken(company);
    const raw = await atsFetchJson(JOB_DETAILS_URL, {
      method: "POST",
      body: webbtreeJdRequestBody(company.slug, posting.externalId, ceToken),
      headers: { customurl: webbtreeCustomUrlHeader(company.slug, ceToken) },
      provider: "webbtree",
    });
    const parsed = parseOrNull(WebbtreeJobDetailsResponseSchema, raw, {
      provider: "webbtree",
      slug: company.slug,
      what: `getjobdetails ${posting.externalId}`,
    });
    if (!parsed) return "";
    return htmlToText(parsed.message?.details?.jobdescription ?? "");
  },
};
