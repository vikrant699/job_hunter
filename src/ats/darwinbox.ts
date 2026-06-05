// src/ats/darwinbox.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { browserFetchJson } from "./browser-fetch.js";

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere)\b/i;

const JobSchema = z.object({
  id: z.string(),
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
    postedAt: j.job_posting_on ? new Date(j.job_posting_on * 1000).toISOString() : (j.created_on ?? null),
  };
}

const CAREERS_PATH = "/ms/candidate/careers";
const API = (page: number) => `/ms/candidateapi/job?page=${page}&companyId=main`;

export const darwinboxAdapter: AtsAdapter = {
  provider: "darwinbox",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = darwinboxTenantBase(company);
    const careersUrl = `${base}${CAREERS_PATH}`;
    const out: NormalizedPosting[] = [];
    // First page (in-browser; clears Cloudflare) reveals jobscount.
    const [first] = await browserFetchJson(careersUrl, [API(1)]);
    const parsed0 = ListSchema.safeParse(first);
    if (!parsed0.success) throw new Error(`darwinbox list failed schema for ${company.slug}`);
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
        for (const raw of results) {
          const parsed = ListSchema.safeParse(raw);
          if (!parsed.success || parsed.data.message.jobs.length === 0) break;
          for (const j of parsed.data.message.jobs) out.push(normalizeDarwinbox(company, j));
          if (out.length >= total) break;
        }
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
    const msg = (raw as { message?: Record<string, unknown> })?.message ?? {};
    const jobArr = msg["job"];
    const jobObj = Array.isArray(jobArr) ? (jobArr[0] as Record<string, unknown>) : msg;
    const jd = (jobObj["jd"] ?? jobObj["job_description"] ?? jobObj["description"] ?? "") as string;
    // Darwinbox's API returns HTML-encoded HTML (e.g. &lt;p&gt;...&lt;/p&gt;).
    // Decode entities once to get real HTML, then strip tags to plain text.
    const jdRaw = typeof jd === "string" ? jd : "";
    return htmlToText(htmlToText(jdRaw));
  },
};
