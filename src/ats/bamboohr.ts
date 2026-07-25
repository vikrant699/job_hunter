// src/ats/bamboohr.ts — BambooHR hosted career sites, e.g. noorahealth.bamboohr.com.
// Two-phase JSON API, no auth, no pagination (single array + totalCount):
//   GET <tenant>.bamboohr.com/careers/list           -> { meta, result: Job[] }
//   GET <tenant>.bamboohr.com/careers/<id>/detail    -> { meta, result: { jobOpening } }
// `company.slug` is the tenant subdomain. The list endpoint's location data is
// split across two objects (`location` and `atsLocation`) and either one may
// be the one actually populated — sometimes with city/state swapped or a
// pincode sitting in `state`/`province`. We just join whichever object has
// non-null parts rather than trying to normalize the swap.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE } from "./shared.js";

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
  meta: z.unknown().optional(),
  result: z.object({
    jobOpening: z.object({
      jobOpeningShareUrl: z.string().nullable().optional(),
      jobOpeningName: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  }),
});

/** List/detail endpoints for one tenant. */
export function bambooHrListUrl(slug: string): string {
  return `https://${slug}.bamboohr.com/careers/list`;
}
export function bambooHrDetailUrl(slug: string, id: string): string {
  return `https://${slug}.bamboohr.com/careers/${id}/detail`;
}
/** The share URL pattern is stable and derivable from list data alone —
 * verified against the detail endpoint's `jobOpeningShareUrl`. */
export function bambooHrJobUrl(slug: string, id: string): string {
  return `https://${slug}.bamboohr.com/careers/${id}`;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join(", ");
}

/**
 * Build a location string from whichever of `location`/`atsLocation` is
 * actually populated. Field semantics are inconsistent between tenants/rows
 * (e.g. a pincode may land in `state` or `province`, a state name may land
 * in `city`) so we don't try to disambiguate — just surface every non-null
 * part in a stable order.
 */
export function buildBambooHrLocation(
  location: z.infer<typeof LocationSchema>,
  atsLocation: z.infer<typeof AtsLocationSchema>,
): string | null {
  const fromLocation = joinParts([location?.city, location?.state]);
  if (fromLocation) return fromLocation;
  const fromAtsLocation = joinParts([atsLocation?.city, atsLocation?.province, atsLocation?.state, atsLocation?.country]);
  return fromAtsLocation || null;
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
