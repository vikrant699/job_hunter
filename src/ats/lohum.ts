// list: GET lohum.com/api/Currentopening/getlist -> bare array, no pagination/envelope
// jd: inline (jobdescription); no per-job URL so jobUrl falls back to the careers page
import { z } from "zod";
import { makeJsonListAdapter } from "./jsonList.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { joinLocation, REMOTE_RE } from "./shared.js";

export function lohumListUrl(): string {
  return "https://lohum.com/api/Currentopening/getlist";
}

export const LohumJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  designation: z.string(),
  experience: z.number().nullable().optional(),
  jobtype: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  jobdescription: z.string().nullable().optional(),
});
export type LohumJob = z.infer<typeof LohumJobSchema>;

export const LohumResponseSchema = z.array(LohumJobSchema);

export function normalizeLohum(company: AdapterCompany, j: LohumJob): NormalizedPosting {
  const location = joinLocation(j.location);
  return {
    provider: "lohum",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.designation,
    jobUrl: company.careersUrl,
    location,
    isRemote: location !== null && REMOTE_RE.test(location),
    jdText: htmlToText(j.jobdescription ?? ""),
    postedAt: null,
  };
}

export const lohumAdapter = makeJsonListAdapter({
  provider: "lohum",
  url: lohumListUrl,
  schema: LohumResponseSchema,
  items: (parsed) => parsed,
  normalize: normalizeLohum,
});
