// src/ats/bamboohr.ts — BambooHR hosted career sites (<tenant>.bamboohr.com), two-phase JSON API, no auth, no pagination.
// GET /careers/list and GET /careers/<id>/detail. Location is split across `location`/`atsLocation`, either may be
// populated (sometimes with city/state swapped or a pincode in state/province) - we just join whichever has parts.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, joinLocation } from "./shared.js";
import { JsonValueSchema } from "../util/json.js";

const LocationSchema = z
  .object({
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const AtsLocationSchema = z
  .object({
    country: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    province: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const ListJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jobOpeningName: z.string(),
  departmentLabel: z.string().nullable().optional(),
  employmentStatusLabel: z.string().nullable().optional(),
  location: LocationSchema,
  atsLocation: AtsLocationSchema,
  isRemote: z.boolean().nullable().optional(),
  locationType: z.union([z.string(), z.number()]).nullable().optional(),
});
export type BambooHrJob = z.infer<typeof ListJobSchema>;

const ListResponseSchema = z.object({
  meta: z.object({ totalCount: z.number().optional() }).nullable().optional(),
  result: z.array(ListJobSchema),
});

const DetailResponseSchema = z.object({
  meta: JsonValueSchema.optional(),
  result: z.object({
    jobOpening: z.object({
      jobOpeningShareUrl: z.string().nullable().optional(),
      jobOpeningName: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  }),
});

export function bambooHrListUrl(slug: string): string {
  return `https://${slug}.bamboohr.com/careers/list`;
}
export function bambooHrDetailUrl(slug: string, id: string): string {
  return `https://${slug}.bamboohr.com/careers/${id}/detail`;
}
export function bambooHrJobUrl(slug: string, id: string): string {
  return `https://${slug}.bamboohr.com/careers/${id}`;
}

export function buildBambooHrLocation(
  location: z.infer<typeof LocationSchema>,
  atsLocation: z.infer<typeof AtsLocationSchema>,
): string | null {
  const fromLocation = joinLocation(location?.city, location?.state);
  if (fromLocation) return fromLocation;
  return joinLocation(atsLocation?.city, atsLocation?.province, atsLocation?.state, atsLocation?.country);
}

export function normalizeBambooHr(company: AdapterCompany, j: BambooHrJob): NormalizedPosting {
  const id = String(j.id);
  const location = buildBambooHrLocation(j.location, j.atsLocation);
  const locationTypeStr = j.locationType != null ? String(j.locationType) : "";
  return {
    provider: "bamboohr",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobOpeningName,
    jobUrl: bambooHrJobUrl(company.slug, id),
    location,
    isRemote: Boolean(j.isRemote) || REMOTE_RE.test(`${locationTypeStr} ${location ?? ""}`),
    jdText: "",
    postedAt: null,
  };
}

export const bambooHrAdapter: AtsAdapter = {
  provider: "bamboohr",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(bambooHrListUrl(company.slug), { provider: "bamboohr" });
    const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "bamboohr", slug: company.slug });
    return parsed.result.map((j) => normalizeBambooHr(company, j));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(bambooHrDetailUrl(company.slug, posting.externalId), { provider: "bamboohr" });
    const parsed = parseOrNull(DetailResponseSchema, raw, {
      provider: "bamboohr",
      slug: company.slug,
      what: `detail ${posting.externalId}`,
    });
    if (!parsed) return "";
    return htmlToText(parsed.result.jobOpening.description ?? "");
  },
};
