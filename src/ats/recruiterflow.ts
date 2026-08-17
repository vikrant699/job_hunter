// src/ats/recruiterflow.ts — Recruiterflow career boards, shared origin (recruiterflow.com/<slug>/jobs),
// one path segment per tenant. No XHR/GraphQL call is made: the board's bare HTML embeds every
// posting inline in a plain `<script>window.jobsList = {"department": [...], "group": [...],
// "location": [...]}</script>` literal (all three groupings hold the same postings by different
// keys); we read `department` and dedup by job_id. JD comes from a separate per-job JSON-LD block.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, dateToIso, extractBalanced } from "./shared.js";
import { tryParseJson } from "../util/json.js";

const RF_ORIGIN = "https://recruiterflow.com";

export function recruiterflowSlug(company: AdapterCompany): string {
  const raw = company.tenantUrl ?? company.careersUrl;
  const { pathname } = new URL(raw);
  const slug = pathname.split("/").filter(Boolean)[0];
  if (!slug) throw new Error(`recruiterflow: cannot derive slug from ${raw}`);
  return slug;
}

export function recruiterflowListUrl(company: AdapterCompany): string {
  return `${RF_ORIGIN}/${recruiterflowSlug(company)}/jobs`;
}

export function recruiterflowJobUrl(slug: string, jobId: string | number): string {
  return `${RF_ORIGIN}/${slug}/jobs/${jobId}`;
}

const RfJobStubSchema = z.object({
  apply_link: z.string(),
  details: z.string().nullable().optional(),
  employment_type: z.string().nullable().optional(),
  job_id: z.union([z.number(), z.string()]),
  job_name: z.string(),
  last_opened: z.string().nullable().optional(),
  remote_type: z.string().nullable().optional(),
});
export type RfJobStub = z.infer<typeof RfJobStubSchema>;

const RfGroupSchema = z.array(z.tuple([z.string(), z.array(RfJobStubSchema)]));
const RfJobsListSchema = z.object({ department: RfGroupSchema }).passthrough();

const JOBS_LIST_MARKER = "window.jobsList = ";

// Returns [] if the marker is absent (empty board / vendor layout change); throws only when the
// marker is present but malformed.
export function parseRecruiterflowJobsList(html: string): RfJobStub[] {
  const objectText = extractBalanced(html, JOBS_LIST_MARKER, "{");
  if (!objectText) return [];

  const raw = tryParseJson(objectText);
  if (raw === null) {
    throw new Error("recruiterflow: window.jobsList is present but not valid JSON");
  }

  const parsed = RfJobsListSchema.parse(raw);
  const seen = new Set<string>();
  const stubs: RfJobStub[] = [];
  for (const [, jobs] of parsed.department) {
    for (const job of jobs) {
      const id = String(job.job_id);
      if (seen.has(id)) continue;
      seen.add(id);
      stubs.push(job);
    }
  }
  return stubs;
}

// Returns "" (not a throw) on any parse/shape failure — an empty JD degrades the posting instead
// of failing the run.
export function parseRecruiterflowJd(html: string): string {
  const [job] = extractJsonLdJobs(html);
  return htmlToText(job?.description ?? "");
}

export function normalizeRecruiterflow(company: AdapterCompany, slug: string, job: RfJobStub): NormalizedPosting {
  const location = job.details ?? null;
  const isRemote = !!job.remote_type || (location ? REMOTE_RE.test(location) : false);
  return {
    provider: "recruiterflow",
    externalId: String(job.job_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: job.job_name,
    jobUrl: recruiterflowJobUrl(slug, job.job_id),
    location,
    isRemote,
    jdText: "",
    postedAt: dateToIso(job.last_opened),
  };
}

export const recruiterflowAdapter: AtsAdapter = {
  provider: "recruiterflow",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = recruiterflowSlug(company);
    const html = await atsFetchText(recruiterflowListUrl(company), { provider: "recruiterflow" });

    let stubs: RfJobStub[];
    try {
      stubs = parseRecruiterflowJobsList(html);
    } catch (err) {
      logger.warn({ slug, err: String(err) }, "recruiterflow list schema mismatch");
      throw new Error(`recruiterflow: unexpected jobsList shape for ${slug}`);
    }

    return stubs.map((job) => normalizeRecruiterflow(company, slug, job));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "recruiterflow" });
    return parseRecruiterflowJd(html);
  },
};
