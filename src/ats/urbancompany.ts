// src/ats/urbancompany.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";

// Urban Company single-tenant board API (backed by TurboHire under the hood,
// but exposed through Urban Company's own gateway rather than a shared
// TurboHire host, so this is a single-company adapter):
//   POST www.urbanclap.com/api/v2/platform-gateway/getAllJobs
//   Content-Type: application/json, body {}
//   -> { jobs: JobRow[] }
// One-phase: `job_description` (full HTML) and `apply_url` are inline on
// every row — no separate detail fetch. No pagination/count field observed;
// `jobs` is returned as one array, so listPostings just maps it directly.
const JobSchema = z.object({
  job_id: z.string(),
  job_code: z.string().nullable().optional(),
  parent_department: z.string().nullable().optional(),
  location: z.array(z.string()).nullable().optional(),
  location_city: z.array(z.string()).nullable().optional(),
  job_title: z.string(),
  job_description: z.string().nullable().optional(),
  apply_url: z.string().nullable().optional(),
});
type Job = z.infer<typeof JobSchema>;
const ResponseSchema = z.object({ jobs: z.array(JobSchema) });

const LIST_URL = "https://www.urbanclap.com/api/v2/platform-gateway/getAllJobs";
const CAREERS_URL = "https://careers.urbancompany.com";

export const urbancompanyAdapter: AtsAdapter = {
  provider: "urbancompany",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(LIST_URL, { method: "POST", body: {}, provider: "urbancompany" });
    const parsed = parseOrThrow(ResponseSchema, raw, { provider: "urbancompany", slug: company.slug });
    return parsed.jobs.map((j) => normalizeUrbancompany(company, j));
  },
};

export function normalizeUrbancompany(company: AdapterCompany, j: Job): NormalizedPosting {
  const location = (j.location ?? []).filter(Boolean).join("; ") || null;
  return {
    provider: "urbancompany",
    externalId: j.job_id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.job_title,
    jobUrl: j.apply_url || CAREERS_URL,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.job_description ?? ""),
    postedAt: null,
  };
}
