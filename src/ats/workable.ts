// src/ats/workable.ts
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { joinLocation } from "./shared.js";

// Workable public widget API:
//   GET apply.workable.com/api/v1/widget/accounts/<slug>?details=true
// One-phase: details=true returns the full HTML description inline.
const LocationSchema = z.object({
  country: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
});
const JobSchema = z.object({
  title: z.string(),
  shortcode: z.string(),
  url: z.string().nullable().optional(),
  shortlink: z.string().nullable().optional(),
  telecommuting: z.boolean().nullable().optional(),
  published_on: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  locations: z.array(LocationSchema).nullable().optional(),
  description: z.string().nullable().optional(),
});
type Job = z.infer<typeof JobSchema>;
const ResponseSchema = z.object({ name: z.string().optional(), jobs: z.array(JobSchema) });

export const workableAdapter: AtsAdapter = {
  provider: "workable",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const account = company.apiMeta?.boardSlug ?? company.slug;
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`;
    const raw = await atsFetchJson(url, { provider: "workable" });
    const parsed = parseOrThrow(ResponseSchema, raw, { provider: "workable", slug: company.slug });
    return parsed.jobs.map((j) => normalizeWorkable(company, j));
  },
};

export function normalizeWorkable(company: AdapterCompany, j: Job): NormalizedPosting {
  // Join EVERY location, not just the first: the widget API serializes
  // multi-location postings with a locations[] array (and sometimes as
  // duplicate rows), and keeping only [0] geo-rejected postings whose first
  // location is foreign but which also hire in India ("Boston; Bengaluru").
  // The location filter deliberately keeps multi-location strings whose
  // foreign city sits next to an in-region one.
  const locs = (j.locations ?? [])
    .map((l) => joinLocation(l.city, l.region, l.country))
    .filter((s): s is string => s !== null);
  const location =
    locs.length > 0 ? [...new Set(locs)].join("; ") : joinLocation(j.city, j.state, j.country);
  return {
    provider: "workable",
    externalId: j.shortcode,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.url ?? j.shortlink ?? `https://apply.workable.com/${company.slug}/`,
    location,
    isRemote: j.telecommuting === true,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.published_on ?? j.created_at ?? null,
  };
}
