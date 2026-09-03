// list: GET careers-api-eight.vercel.app/api/jobs -> { Total, Jobs[] } with full JD inline; page/limit params ignored, always returns the whole set
// Location is a JSON-encoded string of [{Address, PlaceId}]
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { logger } from "../logger.js";
import type { JsonValue } from "../util/json.js";

const LEAPSCHOLAR_JOBS_URL = "https://careers-api-eight.vercel.app/api/jobs";

export const LeapscholarJobSchema = z.object({
  JobId: z.string(),
  JobTitle: z.string(),
  JobDescription: z.string().nullable().optional(),
  Department: z.string().nullable().optional(),
  Location: z.string().nullable().optional(),
  JobType: z.string().nullable().optional(),
  ApplyUrl: z.string().nullable().optional(),
  PublishedDate: z.string().nullable().optional(),
  CreatedDate: z.string().nullable().optional(),
});
export type LeapscholarJob = z.infer<typeof LeapscholarJobSchema>;

const LeapscholarResponseSchema = z.object({
  Total: z.number(),
  Jobs: z.array(LeapscholarJobSchema),
});

const LeapscholarLocationEntrySchema = z.object({ Address: z.string().nullable().optional() });
const LeapscholarLocationArraySchema = z.array(LeapscholarLocationEntrySchema);

/** `Location` is a JSON-encoded `[{Address, PlaceId}]` string; joins multiple addresses. */
function parseLeapscholarLocation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: z.SafeParseReturnType<JsonValue, z.infer<typeof LeapscholarLocationArraySchema>>;
  try {
    parsed = LeapscholarLocationArraySchema.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const addresses = parsed.data.map((entry) => entry.Address).filter((a): a is string => Boolean(a));
  return addresses.length > 0 ? addresses.join("; ") : null;
}

/** Unwraps `{Total, Jobs}`, warning if Total disagrees with Jobs.length (no pagination, so a mismatch likely means the server started paginating). */
export function leapscholarJobs(json: JsonValue): LeapscholarJob[] {
  const parsed = LeapscholarResponseSchema.parse(json);
  if (parsed.Total !== parsed.Jobs.length) {
    logger.warn(
      { total: parsed.Total, received: parsed.Jobs.length },
      "leapscholar: Total disagrees with Jobs.length — API may have started paginating",
    );
  }
  return parsed.Jobs;
}

export function normalizeLeapscholar(company: AdapterCompany, j: LeapscholarJob): NormalizedPosting {
  const location = parseLeapscholarLocation(j.Location);
  return {
    provider: "leapscholar",
    externalId: j.JobId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.JobTitle,
    jobUrl: j.ApplyUrl ?? company.careersUrl,
    location,
    isRemote: REMOTE_RE.test(`${j.JobType ?? ""} ${location ?? ""}`),
    jdText: htmlToText(j.JobDescription ?? ""),
    postedAt: j.PublishedDate ?? j.CreatedDate ?? null,
  };
}

export const leapscholarAdapter: AtsAdapter = {
  provider: "leapscholar",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const json = await atsFetchJson(LEAPSCHOLAR_JOBS_URL, { provider: "leapscholar" });
    return leapscholarJobs(json).map((j) => normalizeLeapscholar(company, j));
  },
  // The list response carries the full description — no fetchJd needed.
};
