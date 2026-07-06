// src/ats/darwinbox.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema, type JsonValue } from "../util/json.js";
import { logger } from "../logger.js";
import { htmlToText } from "./html-text.js";
import { browserFetchJson } from "./browser-fetch.js";
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

export const darwinboxAdapter: AtsAdapter = {
  provider: "darwinbox",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
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
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const base = darwinboxTenantBase(company);
    const careersUrl = `${base}${CAREERS_PATH}`;
    const [raw] = await browserFetchJson(careersUrl, [`/ms/candidateapi/job/${encodeURIComponent(posting.externalId)}?companyId=main`]);
    // Confirmed live: detail.message = { job: [{...fields, jd: "<html>"}], isSaved: bool }
    // "jd" is the primary key; tolerate flat-object fallback for other tenants.
    const parseResult = JsonValueSchema.safeParse(raw);
    const rawVal: JsonValue = parseResult.success ? parseResult.data : null;
    const rawObj = typeof rawVal === "object" && rawVal !== null && !Array.isArray(rawVal) ? rawVal : null;
    const msg = typeof rawObj?.["message"] === "object" && rawObj["message"] !== null && !Array.isArray(rawObj["message"]) ? rawObj["message"] : null;
    const msgObj = msg ?? rawObj ?? {};
    const jobArr = msgObj["job"];
    const jobArrItem = Array.isArray(jobArr) ? jobArr[0] : null;
    const jobObj = typeof jobArrItem === "object" && jobArrItem !== null && !Array.isArray(jobArrItem) ? jobArrItem : msgObj;
    const jdRaw = jobObj["jd"] ?? jobObj["job_description"] ?? jobObj["description"] ?? "";
    const jd = typeof jdRaw === "string" ? jdRaw : "";
    // Darwinbox's API returns HTML-encoded HTML (e.g. &lt;p&gt;...&lt;/p&gt;).
    // Decode entities once to get real HTML, then strip tags to plain text.
    return htmlToText(htmlToText(jd));
  },
};
