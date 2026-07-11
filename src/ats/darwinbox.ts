// src/ats/darwinbox.ts
//
// Darwinbox career portals come in two generations:
//  - legacy: /ms/candidate/careers + /ms/candidateapi/job?page=N&companyId=main
//  - candidatev2: /ms/candidatev2/<token>/careers/... (the SPA rewrite; token
//    is a per-tenant id, sometimes literally "main"). Its job list API
//    (/ms/candidateapi/job/alljobs, POST) returns the FULL jd inline per job —
//    no separate detail fetch needed, like jibe.ts. Detected purely from the
//    registered careers/tenant URL so existing legacy rows are unaffected.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema, getObj, type JsonValue } from "../util/json.js";
import { logger } from "../logger.js";
import { htmlToText } from "./html-text.js";
import { browserFetchJson, browserFetchJsonRequests } from "./browser-fetch.js";
import { REMOTE_RE, unixToIso } from "./shared.js";

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

/** Origin (https://<tenant>.darwinbox.in) from the careers/tenant URL. */
export function darwinboxTenantBase(company: AdapterCompany): string {
  const u = new URL(company.tenantUrl ?? company.careersUrl);
  return `${u.protocol}//${u.host}`;
}

// ---- generation detection: legacy vs candidatev2 ----

const CANDIDATEV2_RE = /\/ms\/candidatev2\/([^/]+)\//i;

/**
 * The per-tenant token from a `/ms/candidatev2/<token>/...` careers URL
 * (sometimes literally "main"), or null if this company's registered URL is
 * the legacy `/ms/candidate/careers` generation.
 */
export function darwinboxV2Token(company: AdapterCompany): string | null {
  const raw = company.tenantUrl ?? company.careersUrl;
  const match = CANDIDATEV2_RE.exec(raw);
  return match ? match[1]! : null;
}

export function normalizeDarwinbox(company: AdapterCompany, j: DarwinboxJob): NormalizedPosting {
  const location = j.officelocation_show_arr ?? null;
  const title = (j.title && j.title.trim()) || j.designation_display_name || "";
  return {
    provider: "darwinbox",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: `${darwinboxTenantBase(company)}/ms/candidate/careers`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: unixToIso(j.job_posting_on) ?? (j.created_on ?? null),
  };
}

const CAREERS_PATH = "/ms/candidate/careers";
const API = (page: number) => `/ms/candidateapi/job?page=${page}&companyId=main`;

/**
 * Accumulate already-fetched darwinbox list pages (page 2+) into `out`,
 * mutating it in place. Stops early on an empty page or once `total` is
 * reached. Throws — rather than warning and truncating — on a schema
 * mismatch, since a silent `break` here would return a partial list that
 * looks complete (page 1 already throws loudly on the same mismatch, so a
 * mid-stream one must too).
 */
export function mergeDarwinboxPages(
  company: AdapterCompany,
  out: NormalizedPosting[],
  results: unknown[],
  total: number,
): void {
  for (const raw of results) {
    const parsed = ListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `darwinbox: page schema mismatch mid-pagination for ${company.slug} ` +
        `(fetched ${out.length}/${total} so far): ${JSON.stringify(parsed.error.issues.slice(0, 2))}`,
      );
    }
    if (parsed.data.message.jobs.length === 0) break;
    for (const j of parsed.data.message.jobs) out.push(normalizeDarwinbox(company, j));
    if (out.length >= total) break;
  }
}

async function listPostingsLegacy(company: AdapterCompany): Promise<NormalizedPosting[]> {
  const base = darwinboxTenantBase(company);
  const careersUrl = `${base}${CAREERS_PATH}`;
  const out: NormalizedPosting[] = [];
  // First page (in-browser; clears Cloudflare) reveals jobscount.
  const [first] = await browserFetchJson(careersUrl, [API(1)]);
  const parsed0 = ListSchema.safeParse(first);
  if (!parsed0.success) {
    logger.warn({ slug: company.slug, issues: parsed0.error.issues.slice(0, 2) }, "darwinbox schema mismatch");
    throw new Error(`darwinbox list failed schema for ${company.slug}`);
  }
  for (const j of parsed0.data.message.jobs) out.push(normalizeDarwinbox(company, j));
  const total = parsed0.data.message.jobscount ?? out.length;
  // If more pages are needed, fetch them ALL in one browserFetchJson call
  // (one navigation → multiple in-page XHR fetches), instead of N navigations.
  if (out.length < total) {
    const pageSize = parsed0.data.message.jobs.length || 1;
    const pagesNeeded = Math.min(Math.ceil(total / pageSize), 100);
    if (pagesNeeded >= 2) {
      const remainingApis = Array.from({ length: pagesNeeded - 1 }, (_, i) => API(i + 2));
      const results = await browserFetchJson(careersUrl, remainingApis);
      mergeDarwinboxPages(company, out, results, total);
    }
  }
  return out;
}

async function fetchJdLegacy(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
  const base = darwinboxTenantBase(company);
  const careersUrl = `${base}${CAREERS_PATH}`;
  const [raw] = await browserFetchJson(careersUrl, [`/ms/candidateapi/job/${encodeURIComponent(posting.externalId)}?companyId=main`]);
  // Confirmed live: detail.message = { job: [{...fields, jd: "<html>"}], isSaved: bool }
  // "jd" is the primary key; tolerate flat-object fallback for other tenants.
  const parseResult = JsonValueSchema.safeParse(raw);
  const rawVal: JsonValue | null = parseResult.success ? parseResult.data : null;
  const rawObj = getObj(rawVal);
  const msgObj = getObj(rawVal, "message") ?? rawObj ?? {};
  const jobArr = msgObj["job"];
  const jobArrItem = Array.isArray(jobArr) ? jobArr[0] : null;
  const jobObj = getObj(jobArrItem) ?? msgObj;
  const jdRaw = jobObj["jd"] ?? jobObj["job_description"] ?? jobObj["description"] ?? "";
  const jd = typeof jdRaw === "string" ? jdRaw : "";
  // Darwinbox's API returns HTML-encoded HTML (e.g. &lt;p&gt;...&lt;/p&gt;).
  // Decode entities once to get real HTML, then strip tags to plain text.
  return htmlToText(htmlToText(jd));
}

// ---- candidatev2 (SPA rewrite) ----
//
// Confirmed live against LG Soft India (lgsihrms.darwinbox.in, token
// a6914476a29263): POST /ms/candidateapi/job/alljobs?companyId=<token> with
// body {companyId, page, sort_option: "new", limit: 10} returns
// {status, data: [...jobs], job_counts: <total>}. Each job already carries
// the full HTML-encoded `jd` — no per-job detail call, same as jibe.ts.

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

export function normalizeDarwinboxV2(company: AdapterCompany, token: string, j: DarwinboxV2Job): NormalizedPosting {
  const location = j.officelocation_show_arr ?? null;
  const title = (j.title && j.title.trim()) || j.designation_display_name || "";
  // Darwinbox's API returns HTML-encoded HTML (e.g. &lt;p&gt;...&lt;/p&gt;);
  // decode entities once to get real HTML, then strip tags to plain text.
  const jdText = j.jd ? htmlToText(htmlToText(j.jd)) : "";
  return {
    provider: "darwinbox",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: `${darwinboxTenantBase(company)}${V2_CAREERS_PATH(token)}`,
    location,
    isRemote: Boolean(j.is_remote) || (location ? REMOTE_RE.test(location) : false),
    jdText,
    postedAt: j.created_on ?? null,
  };
}

/**
 * Accumulate already-fetched candidatev2 list pages (page 2+) into `out`,
 * mirroring `mergeDarwinboxPages`'s stop/throw semantics for the legacy
 * shape: a schema mismatch throws (rather than silently truncating) since
 * page 1 already throws loudly on the same mismatch.
 */
export function mergeDarwinboxV2Pages(
  company: AdapterCompany,
  token: string,
  out: NormalizedPosting[],
  results: unknown[],
  total: number,
): void {
  for (const raw of results) {
    const parsed = V2ListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `darwinbox(v2): page schema mismatch mid-pagination for ${company.slug} ` +
        `(fetched ${out.length}/${total} so far): ${JSON.stringify(parsed.error.issues.slice(0, 2))}`,
      );
    }
    if (parsed.data.data.length === 0) break;
    for (const j of parsed.data.data) out.push(normalizeDarwinboxV2(company, token, j));
    if (out.length >= total) break;
  }
}

async function listPostingsV2(company: AdapterCompany, token: string): Promise<NormalizedPosting[]> {
  const pageUrl = `${darwinboxTenantBase(company)}${V2_CAREERS_PATH(token)}`;
  const out: NormalizedPosting[] = [];
  const [first] = await browserFetchJsonRequests(pageUrl, [
    { path: V2_API_PATH(token), method: "POST", body: v2ApiBody(token, 1) },
  ]);
  const parsed0 = V2ListSchema.safeParse(first);
  if (!parsed0.success) {
    logger.warn({ slug: company.slug, issues: parsed0.error.issues.slice(0, 2) }, "darwinbox(v2) schema mismatch");
    throw new Error(`darwinbox(v2) list failed schema for ${company.slug}`);
  }
  for (const j of parsed0.data.data) out.push(normalizeDarwinboxV2(company, token, j));
  const total = parsed0.data.job_counts ?? out.length;
  if (out.length < total) {
    const pagesNeeded = Math.min(Math.ceil(total / V2_PAGE_SIZE), 100);
    if (pagesNeeded >= 2) {
      const remaining = Array.from({ length: pagesNeeded - 1 }, (_, i) => ({
        path: V2_API_PATH(token), method: "POST" as const, body: v2ApiBody(token, i + 2),
      }));
      const results = await browserFetchJsonRequests(pageUrl, remaining);
      mergeDarwinboxV2Pages(company, token, out, results, total);
    }
  }
  return out;
}

/**
 * Fallback only: candidatev2's list already embeds the full `jd` (see
 * `normalizeDarwinboxV2`), so the pipeline's `!posting.jdText` guard means
 * this normally never runs. Re-walks the paginated list — bounded the same
 * as `listPostingsV2` — to recover a JD if it was ever empty in the listing.
 */
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
