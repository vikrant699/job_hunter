// src/ats/darwinbox.ts — legacy: /ms/candidate/careers + /ms/candidateapi/job?page=N&companyId=main (per-job detail fetch needed)
// candidatev2: /ms/candidatev2/<token>/careers/... SPA; POST /ms/candidateapi/job/alljobs returns full JD inline per job; generation detected from the registered careers/tenant URL
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { getObj } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { htmlToText } from "./htmlText.js";
import { parseOrThrow } from "./http.js";
import { browserFetchJsonSteps } from "./browserFetch.js";
import type { BrowserJsonStep } from "./browserFetch.js";
import { REMOTE_RE, unixToIso } from "./shared.js";
import { matchGroup } from "../util/regex.js";
import { sleep } from "../util/sleep.js";

const JobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullable().optional(),
  designation_display_name: z.string().nullable().optional(),
  officelocation_show_arr: z.string().nullable().optional(),
  job_posting_on: z.number().nullable().optional(),
  created_on: z.string().nullable().optional(),
});
export type DarwinboxJob = z.infer<typeof JobSchema>;
const ListSchema = z.object({
  status: z.string().optional(),
  message: z.object({ jobscount: z.number().nullable().optional(), jobs: z.array(JobSchema) }),
});

export function darwinboxTenantBase(company: AdapterCompany): string {
  const u = new URL(company.tenantUrl ?? company.careersUrl);
  return `${u.protocol}//${u.host}`;
}

const CANDIDATEV2_RE = /\/ms\/candidatev2\/([^/]+)\//i;

/** The per-tenant token from a candidatev2 careers URL, or null for the legacy generation. */
export function darwinboxV2Token(company: AdapterCompany): string | null {
  const raw = company.tenantUrl ?? company.careersUrl;
  return matchGroup(CANDIDATEV2_RE, raw);
}

// Darwinbox's literal "Multiple locations" placeholder carries no geo signal - null it (EXACT match only) so checkLocation() falls back to the recall-safe title/JD/URL filter instead of wrongly dropping it as out-of-region
const PLACEHOLDER_LOCATION_RE = /^multiple locations?$/i;

export function darwinboxLocation(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || PLACEHOLDER_LOCATION_RE.test(trimmed)) return null;
  return trimmed;
}

export function normalizeDarwinbox(company: AdapterCompany, j: DarwinboxJob): NormalizedPosting {
  const location = darwinboxLocation(j.officelocation_show_arr);
  const title = (j.title && j.title.trim()) || j.designation_display_name || "";
  return {
    provider: "darwinbox",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: darwinboxJobUrl(company, String(j.id)),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: unixToIso(j.job_posting_on) ?? (j.created_on ?? null),
  };
}

// some legacy tenants carry a per-tenant token in the careers path; hardcoding companyId="main" returns 0 jobs for those, so it must be extracted when present
const LEGACY_TOKEN_RE = /\/ms\/candidate\/(?!careers)([^/]+)\/careers/i;
export function legacyCompanyId(company: AdapterCompany): string {
  const raw = company.tenantUrl ?? company.careersUrl;
  return matchGroup(LEGACY_TOKEN_RE, raw) ?? "main";
}
// server-rendered deep link (og:title carries the job) for both generations; legacy tenants resolve under candidatev2 with their companyId token, "main" when untokened
export function darwinboxJobUrl(company: AdapterCompany, externalId: string): string {
  const token = darwinboxV2Token(company) ?? legacyCompanyId(company);
  return `${darwinboxTenantBase(company)}/ms/candidatev2/${encodeURIComponent(token)}/careers/jobDetails/${encodeURIComponent(externalId)}`;
}
const API = (page: number, companyId: string) => `/ms/candidateapi/job?page=${page}&companyId=${encodeURIComponent(companyId)}`;

const MAX_LIST_PAGES = 5000; // runaway backstop only, never truncate

// /ms/candidate/careers boots an SPA that full-navigates to /ms/candidatev2/... seconds after load (late on a slow tenant), killing any in-flight page.evaluate; the JSON API page never navigates and still clears Cloudflare
export function darwinboxLegacyLandingUrl(company: AdapterCompany): string {
  return `${darwinboxTenantBase(company)}${API(1, legacyCompanyId(company))}`;
}

/** Fixed request list as a browserFetchJsonSteps builder, which retries an evaluate killed by a navigation. */
export function darwinboxSteps(steps: BrowserJsonStep[]): (done: JsonValue[]) => BrowserJsonStep | null {
  return (done) => steps[done.length] ?? null;
}

const FORBIDDEN_RE = /\bHTTP 403\b/;
const FORBIDDEN_RETRY_DELAY_MS = 3_000;

/** Cloudflare intermittently 403s one in-page fetch that a fresh session then serves, so retry the whole session once; other failures propagate untouched. */
export async function darwinboxRetryForbidden<T>(run: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!FORBIDDEN_RE.test(String(err))) throw err;
    await wait(FORBIDDEN_RETRY_DELAY_MS);
    return run();
  }
}

function darwinboxFetch(pageUrl: string, steps: BrowserJsonStep[]): Promise<JsonValue[]> {
  return darwinboxRetryForbidden(() => browserFetchJsonSteps(pageUrl, darwinboxSteps(steps)));
}

/** `pageSize` is derived from the live page-1 length, so guard a zero/absent value. */
export function darwinboxPagesNeeded(total: number, pageSize: number): number {
  return Math.min(Math.ceil(total / (pageSize || 1)), MAX_LIST_PAGES);
}

/** Mutates `out` in place; throws (rather than truncating) on a schema mismatch, since a silent break would return a partial list that looks complete. */
export function mergeDarwinboxPages(
  company: AdapterCompany,
  out: NormalizedPosting[],
  results: JsonValue[],
  total: number,
): void {
  for (const raw of results) {
    const parsed = parseOrThrow(ListSchema, raw, {
      provider: "darwinbox",
      slug: company.slug,
      what: `page (fetched ${out.length}/${total} so far)`,
    });
    if (parsed.message.jobs.length === 0) break;
    for (const j of parsed.message.jobs) out.push(normalizeDarwinbox(company, j));
    if (out.length >= total) break;
  }
}

async function listPostingsLegacy(company: AdapterCompany): Promise<NormalizedPosting[]> {
  const landingUrl = darwinboxLegacyLandingUrl(company);
  const companyId = legacyCompanyId(company);
  const out: NormalizedPosting[] = [];
  // First page (in-browser; clears Cloudflare) reveals jobscount.
  const [first] = await darwinboxFetch(landingUrl, [{ url: API(1, companyId) }]);
  const parsed0 = parseOrThrow(ListSchema, first ?? null, { provider: "darwinbox", slug: company.slug });
  for (const j of parsed0.message.jobs) out.push(normalizeDarwinbox(company, j));
  const total = parsed0.message.jobscount ?? out.length;
  // remaining pages share one navigation, one in-page XHR each
  if (out.length < total) {
    const pageSize = parsed0.message.jobs.length;
    const pagesNeeded = darwinboxPagesNeeded(total, pageSize);
    if (pagesNeeded >= 2) {
      const remaining = Array.from({ length: pagesNeeded - 1 }, (_, i) => ({ url: API(i + 2, companyId) }));
      const results = await darwinboxFetch(landingUrl, remaining);
      mergeDarwinboxPages(company, out, results, total);
    }
  }
  return out;
}

async function fetchJdLegacy(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
  const detailPath = `/ms/candidateapi/job/${encodeURIComponent(posting.externalId)}?companyId=${encodeURIComponent(legacyCompanyId(company))}`;
  const [raw] = await darwinboxFetch(darwinboxLegacyLandingUrl(company), [{ url: detailPath }]);
  return darwinboxDetailJd(raw ?? null);
}

/** detail.message = { job: [{...fields, jd}], isSaved }; tolerates a flat-object fallback for other tenants. */
export function darwinboxDetailJd(raw: JsonValue): string {
  const msgObj = getObj(raw, "message") ?? getObj(raw) ?? {};
  const jobArr = msgObj["job"];
  const jobObj = getObj(Array.isArray(jobArr) ? jobArr[0] : null) ?? msgObj;
  const jdRaw = jobObj["jd"] ?? jobObj["job_description"] ?? jobObj["description"] ?? "";
  const jd = typeof jdRaw === "string" ? jdRaw : "";
  // Darwinbox double HTML-encodes the JD (e.g. &lt;p&gt;) - decode once to get real HTML, then strip tags.
  return cleanDarwinboxJd(htmlToText(htmlToText(jd)));
}

// Darwinbox's rich-text editor saves its own hint text as the JD when the recruiter never typed one; null it so the posting takes the honest no-jd path
const PLACEHOLDER_JD_RE = /^please enter job description\.?$/i;
export function cleanDarwinboxJd(jd: string): string {
  return PLACEHOLDER_JD_RE.test(jd.trim()) ? "" : jd;
}

// candidatev2: POST /ms/candidateapi/job/alljobs?companyId=<token> {companyId,page,sort_option,limit} -> {status, data: jobs[], job_counts}; each job carries full HTML-encoded jd (no per-job detail call)
const V2_PAGE_SIZE = 10;
const V2_CAREERS_PATH = (token: string) => `/ms/candidatev2/${token}/careers/allJobs`;
const V2_API_PATH = (token: string) => `/ms/candidateapi/job/alljobs?companyId=${encodeURIComponent(token)}`;
const v2ApiBody = (token: string, page: number) => ({ companyId: token, page, sort_option: "new", limit: V2_PAGE_SIZE });

const V2JobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullable().optional(),
  designation_display_name: z.string().nullable().optional(),
  officelocation_show_arr: z.string().nullable().optional(),
  is_remote: z.union([z.number(), z.boolean()]).nullable().optional(),
  created_on: z.string().nullable().optional(),
  jd: z.string().nullable().optional(),
});
export type DarwinboxV2Job = z.infer<typeof V2JobSchema>;

const V2ListSchema = z.object({
  status: z.string().optional(),
  data: z.array(V2JobSchema),
  job_counts: z.number().nullable().optional(),
});

export function normalizeDarwinboxV2(company: AdapterCompany, j: DarwinboxV2Job): NormalizedPosting {
  const location = darwinboxLocation(j.officelocation_show_arr);
  const title = (j.title && j.title.trim()) || j.designation_display_name || "";
  const jdText = j.jd ? cleanDarwinboxJd(htmlToText(htmlToText(j.jd))) : ""; // double HTML-encoded, see fetchJdLegacy
  return {
    provider: "darwinbox",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: darwinboxJobUrl(company, String(j.id)),
    location,
    isRemote: Boolean(j.is_remote) || (location ? REMOTE_RE.test(location) : false),
    jdText,
    postedAt: j.created_on ?? null,
  };
}

/** Mirrors `mergeDarwinboxPages`'s stop/throw semantics: a schema mismatch throws rather than silently truncating. */
export function mergeDarwinboxV2Pages(
  company: AdapterCompany,
  out: NormalizedPosting[],
  results: JsonValue[],
  total: number,
): void {
  for (const raw of results) {
    const parsed = parseOrThrow(V2ListSchema, raw, {
      provider: "darwinbox",
      slug: company.slug,
      what: `v2 page (fetched ${out.length}/${total} so far)`,
    });
    if (parsed.data.length === 0) break;
    for (const j of parsed.data) out.push(normalizeDarwinboxV2(company, j));
    if (out.length >= total) break;
  }
}

async function listPostingsV2(company: AdapterCompany, token: string): Promise<NormalizedPosting[]> {
  const pageUrl = `${darwinboxTenantBase(company)}${V2_CAREERS_PATH(token)}`;
  const out: NormalizedPosting[] = [];
  const [first] = await darwinboxFetch(pageUrl, [
    { url: V2_API_PATH(token), method: "POST", body: v2ApiBody(token, 1) },
  ]);
  const parsed0 = parseOrThrow(V2ListSchema, first ?? null, { provider: "darwinbox", slug: company.slug, what: "v2 list" });
  for (const j of parsed0.data) out.push(normalizeDarwinboxV2(company, j));
  const total = parsed0.job_counts ?? out.length;
  if (out.length < total) {
    // Deriving page size from the actual response (rather than trusting `limit`) keeps a limit-ignoring tenant correct.
    const pagesNeeded = darwinboxPagesNeeded(total, parsed0.data.length || V2_PAGE_SIZE);
    if (pagesNeeded >= 2) {
      const remaining = Array.from({ length: pagesNeeded - 1 }, (_, i) => ({
        url: V2_API_PATH(token), method: "POST" as const, body: v2ApiBody(token, i + 2),
      }));
      const results = await darwinboxFetch(pageUrl, remaining);
      mergeDarwinboxV2Pages(company, out, results, total);
    }
  }
  return out;
}

// fallback only: candidatev2's list already embeds the full jd, so the pipeline's !jdText guard means this normally never runs
async function fetchJdV2(company: AdapterCompany, token: string, posting: NormalizedPosting): Promise<string> {
  const postings = await listPostingsV2(company, token);
  const match = postings.find((p) => p.externalId === posting.externalId);
  return match?.jdText ?? "";
}

export const darwinboxAdapter: AtsAdapter = {
  provider: "darwinbox",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const token = darwinboxV2Token(company);
    return token !== null ? listPostingsV2(company, token) : listPostingsLegacy(company);
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const token = darwinboxV2Token(company);
    return token !== null ? fetchJdV2(company, token, posting) : fetchJdLegacy(company, posting);
  },
};
