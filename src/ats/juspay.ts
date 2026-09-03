// list: GET joinus.juspay.in/api/careerJobOpening?limit=1000 -> { allJobs[] }; totalCount echoes the limit param (bogus), completeness relies on the fixed limit
// jd: inline in job_description_career (or job_description_template); no per-job endpoint
import { z } from "zod";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { makeJsonListAdapter } from "./jsonList.js";
import { REMOTE_RE } from "./shared.js";

const LIST_URL = "https://joinus.juspay.in/api/careerJobOpening?limit=1000";
const BOARD_URL = "https://juspay.io/careers";

export const JuspayJobSchema = z.object({
  job_id: z.union([z.string(), z.number()]),
  job_title: z.string(),
  job_location: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  job_type: z.string().nullable().optional(),
  opening_status: z.union([z.string(), z.boolean()]).nullable().optional(),
  job_description_career: z.string().nullable().optional(),
  job_description_template: z.string().nullable().optional(),
});
export type JuspayJob = z.infer<typeof JuspayJobSchema>;

export const JuspayResponseSchema = z.object({
  allJobs: z.array(JuspayJobSchema),
});

export function normalizeJuspayJob(company: AdapterCompany, j: JuspayJob): NormalizedPosting {
  const location = j.job_location?.trim() || null;
  return {
    provider: "juspay",
    externalId: String(j.job_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.job_title,
    jobUrl: BOARD_URL,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: (j.job_description_career ?? j.job_description_template ?? "").trim(),
    postedAt: null,
  };
}

export const juspayAdapter = makeJsonListAdapter({
  provider: "juspay",
  url: () => LIST_URL,
  schema: JuspayResponseSchema,
  items: (parsed) => parsed.allJobs,
  normalize: normalizeJuspayJob,
});
