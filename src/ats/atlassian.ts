// src/ats/atlassian.ts — Atlassian's own careers endpoint (iCIMS-backed, but the
// public JSON feed lives on their marketing site, not on iCIMS):
//   GET https://www.atlassian.com/endpoint/careers/listings
// returns a bare JSON ARRAY of every open role — no pagination, no auth
// (verified live: 199 jobs, 18 India). The FULL JD is inline, split across
// three HTML fields (`overview`, `responsibilities`, `qualifications`);
// `applyUrl`/`portalJobPost.portalUrl` point at the per-role iCIMS portal page.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const ATLASSIAN_LISTINGS_URL = "https://www.atlassian.com/endpoint/careers/listings";

export const AtlassianJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  locations: z.array(z.string()).nullable().optional(),
  overview: z.string().nullable().optional(),
  responsibilities: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  portalJobPost: z
    .object({
      portalUrl: z.string().nullable().optional(),
      updatedDate: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type AtlassianJob = z.infer<typeof AtlassianJobSchema>;

const AtlassianListingsSchema = z.array(z.unknown());

/** Parse the bare listings array, skipping malformed entries. */
export function parseAtlassianListings(json: unknown): AtlassianJob[] {
  const arr = AtlassianListingsSchema.parse(json);
  const jobs: AtlassianJob[] = [];
  for (const raw of arr) {
    const parsed = AtlassianJobSchema.safeParse(raw);
    if (parsed.success) jobs.push(parsed.data);
  }
  return jobs;
}

/** The full JD is split across three inline HTML fields — join what's present. */
export function atlassianJdText(j: AtlassianJob): string {
  const parts = [j.overview, j.responsibilities, j.qualifications].filter((p): p is string => Boolean(p));
  return htmlToText(parts.join("\n"));
}

export function normalizeAtlassian(company: AdapterCompany, j: AtlassianJob): NormalizedPosting {
  const locations = j.locations ?? [];
  const location = locations.length > 0 ? locations.join("; ") : null;
  return {
    provider: "atlassian",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.portalJobPost?.portalUrl ?? j.applyUrl ?? company.careersUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: atlassianJdText(j),
    postedAt: j.portalJobPost?.updatedDate ?? null,
  };
}

export const atlassianAdapter: AtsAdapter = {
  provider: "atlassian",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const json = await atsFetchJson(ATLASSIAN_LISTINGS_URL, { provider: "atlassian" });
    const jobs = parseAtlassianListings(json);
    if (jobs.length === 0) throw new Error("atlassian: listings endpoint returned no parseable jobs");
    return jobs.map((j) => normalizeAtlassian(company, j));
  },
  // The listing carries the full JD inline (overview+responsibilities+qualifications).
};
