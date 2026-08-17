// src/ats/sharechat.ts — ShareChat's public careers JSON API (also backs Moj, same product/board); single-host, no per-tenant subdomain.
// GET /api/careersList groups jobs by category (flatten across groups); no per-job detail endpoint exists, so jdText stays "" and jobUrl points at the careers page.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, epochMsToIso } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const CAREERS_LIST_URL = "https://sharechat.com/api/careersList?limit=100";

export const ShareChatJobSchema = z.object({
  requisitionId: z.number(),
  requisitionTitle: z.string(),
  orgUnitName: z.string().nullable().optional(),
  officeLocationNames: z.array(z.string()).nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  createdDate: z.number().nullable().optional(),
});
export type ShareChatJob = z.infer<typeof ShareChatJobSchema>;

const ShareChatGroupSchema = z.object({
  title: z.string(),
  data: z.array(ShareChatJobSchema),
});

const ShareChatListResponseSchema = z.object({
  data: z.object({ careersList: z.array(ShareChatGroupSchema) }),
});

/** Flatten the category-grouped `careersList[].data[]` into one job array. */
export function flattenShareChatJobs(raw: JsonValue): ShareChatJob[] {
  const parsed = ShareChatListResponseSchema.parse(raw);
  return parsed.data.careersList.flatMap((group) => group.data);
}

export function normalizeShareChat(company: AdapterCompany, j: ShareChatJob): NormalizedPosting {
  const location = j.officeLocationNames?.length ? j.officeLocationNames.join(", ") : null;
  return {
    provider: "sharechat",
    externalId: String(j.requisitionId),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.requisitionTitle,
    jobUrl: company.careersUrl,
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: j.jobDescription ? htmlToText(j.jobDescription) : "",
    postedAt: epochMsToIso(j.createdDate),
  };
}

export const sharechatAdapter: AtsAdapter = {
  provider: "sharechat",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(CAREERS_LIST_URL, { provider: "sharechat" });
    const jobs = flattenShareChatJobs(raw);
    return jobs.map((j) => normalizeShareChat(company, j));
  },
};
