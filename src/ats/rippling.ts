// src/ats/rippling.ts — Rippling ATS (ats.rippling.com), a shared public
// no-auth job-board API used by many companies on Rippling's recruiting
// product. One tenant per company, keyed by the registry source_slug:
//
//   list:   GET https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs
//           -> JSON array of
//              { uuid, name, department: {id,label} | null,
//                url, workLocation: {id,label} }
//           No pagination observed live (single flat array); a company with
//           openings in multiple locations gets one array entry per
//           (job, location) pair, all sharing the same uuid. No auth, no
//           pagination params.
//
//   detail: GET https://api.rippling.com/platform/api/ats/v1/board/<slug>/jobs/<uuid>
//           -> { uuid, name, description: { company, role }, workLocations,
//                department, url, ... }
//           `description.company` and `description.role` are HTML strings
//           (verified live against slug "centricity-research"): `company` is
//           the "why join us" blurb, `role` is the "about the role" body.
//           The JD is built by concatenating whichever of [company, role]
//           are present and non-empty (in that order), then stripping HTML.
//           The list response carries no date field, so postedAt is always
//           null.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const API_ORIGIN = "https://api.rippling.com";

const RipplingLabelSchema = z.object({
  id: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
});

const RipplingJobSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  department: RipplingLabelSchema.nullable().optional(),
  url: z.string(),
  workLocation: RipplingLabelSchema.nullable().optional(),
});
export type RipplingJob = z.infer<typeof RipplingJobSchema>;

const RipplingListSchema = z.array(RipplingJobSchema);

const RipplingDescriptionSchema = z.object({
  company: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
});

const RipplingDetailSchema = z.object({
  uuid: z.string(),
  description: RipplingDescriptionSchema.nullable().optional(),
});
export type RipplingDetail = z.infer<typeof RipplingDetailSchema>;

/** Build the job-board list URL for one company (registry source_slug). */
export function ripplingListUrl(companySlug: string): string {
  return `${API_ORIGIN}/platform/api/ats/v1/board/${encodeURIComponent(companySlug)}/jobs`;
}

/** Build the job-detail URL for one posting. */
export function ripplingDetailUrl(companySlug: string, uuid: string): string {
  return `${API_ORIGIN}/platform/api/ats/v1/board/${encodeURIComponent(companySlug)}/jobs/${encodeURIComponent(uuid)}`;
}

export function normalizeRipplingJob(company: AdapterCompany, j: RipplingJob): NormalizedPosting {
  const location = j.workLocation?.label ?? null;
  return {
    provider: "rippling",
    externalId: j.uuid,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.name,
    jobUrl: j.url,
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: "",
    postedAt: null,
  };
}

/** Build the plain-text JD by concatenating, in order, whichever of
 *  [description.company, description.role] are present and non-empty, then
 *  stripping HTML. Throws if neither yields text. */
export function buildRipplingJd(detail: RipplingDetail): string {
  const description = detail.description;
  const parts = [description?.company, description?.role].filter(
    (s): s is string => typeof s === "string" && s.trim() !== "",
  );
  if (parts.length === 0) throw new Error("rippling: job detail had no JD-bearing fields");
  return htmlToText(parts.join("\n\n"));
}

export const ripplingAdapter: AtsAdapter = {
  provider: "rippling",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(ripplingListUrl(company.slug), { provider: "rippling" });
    const parsed = parseOrThrow(RipplingListSchema, raw, { provider: "rippling", slug: company.slug });
    return parsed.map((j) => normalizeRipplingJob(company, j));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(ripplingDetailUrl(company.slug, posting.externalId), { provider: "rippling" });
    const parsed = parseOrThrow(RipplingDetailSchema, raw, {
      provider: "rippling",
      slug: company.slug,
      what: `detail ${posting.externalId}`,
    });
    return buildRipplingJd(parsed);
  },
};
