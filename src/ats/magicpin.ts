// list: GET sales.magicpin.in/magickiosk/career/jobs (bearer JWT baked into the SPA bundle) -> department groups of jobs, no JD body
// jd: GET .../jobs/<id> for requirements+responsibilities
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrNull } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import type { JsonValue } from "../util/json.js";

// Single-tenant: this is magicpin's own site, not a SaaS ATS host pattern.
const API_BASE = "https://sales.magicpin.in/magickiosk/career";
const LIST_URL = `${API_BASE}/jobs`;
const jdUrl = (jobId: string): string => `${API_BASE}/jobs/${encodeURIComponent(jobId)}`;
const jobPageUrl = (jobId: string): string =>
  `https://magicpin.in/careers/jobdescription?jobId=${encodeURIComponent(jobId)}`;

// If this rotates, re-grep a fresh bundle for `Authorization:"Bearer `.
const STATIC_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjYzYTNmOTI0NTNjODViYzEyNjU4ZjNiZSIsInVzZXJuYW1lIjoiSnVkZ2VfQ3JvbmluIiwiaWF0IjoxNjcxNjk3MTcxfQ.hbZLKSsS6Mdj1ndhAf4rm_5we4iWYvKY1VPSo51sQRM";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${STATIC_TOKEN}` };
}

export const MagicpinListJobSchema = z.object({
  _id: z.string(),
  title: z.string(),
  experience: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
});
export type MagicpinListJob = z.infer<typeof MagicpinListJobSchema>;

const MagicpinDeptGroupSchema = z.object({
  _id: z.string(),
  count: z.number().nullable().optional(),
  jobs: z.array(MagicpinListJobSchema),
});

const MagicpinListResponseSchema = z.array(MagicpinDeptGroupSchema);

export function flattenMagicpinJobs(raw: JsonValue): MagicpinListJob[] {
  const parsed = MagicpinListResponseSchema.parse(raw);
  return parsed.flatMap((group) => group.jobs);
}

const MagicpinDetailSchema = z.object({
  _id: z.string(),
  requirements: z.string().nullable().optional(),
  responsibilities: z.string().nullable().optional(),
});

export function normalizeMagicpin(company: AdapterCompany, j: MagicpinListJob): NormalizedPosting {
  return {
    provider: "magicpin",
    externalId: j._id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: jobPageUrl(j._id),
    location: j.location ?? null,
    isRemote: REMOTE_RE.test(j.location ?? ""),
    jdText: "", // list endpoint carries no JD body; fetchJd hits the detail endpoint.
    postedAt: null, // neither list nor detail response carries a reliable posting date.
  };
}

// requirements (HTML) and responsibilities (plain text) are both inconsistently populated; concatenate whichever are non-empty after HTML-stripping.
export function magicpinJdFromDetail(detailJson: JsonValue, ctx: { slug: string; jobId: string }): string {
  const parsed = parseOrNull(MagicpinDetailSchema, detailJson, {
    provider: "magicpin",
    slug: ctx.slug,
    what: `detail ${ctx.jobId}`,
  });
  if (!parsed) return "";
  const parts = [parsed.requirements, parsed.responsibilities]
    .map((s) => htmlToText(s))
    .filter((s) => s.length > 0);
  return parts.join("\n\n");
}

export const magicpinAdapter: AtsAdapter = {
  provider: "magicpin",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const json = await atsFetchJson(LIST_URL, { provider: "magicpin", headers: authHeaders() });
    const jobs = flattenMagicpinJobs(json);
    return jobs.map((j) => normalizeMagicpin(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const json = await atsFetchJson(jdUrl(posting.externalId), { provider: "magicpin", headers: authHeaders() });
    return magicpinJdFromDetail(json, { slug: posting.companySlug, jobId: posting.externalId });
  },
};
