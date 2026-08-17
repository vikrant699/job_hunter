// src/ats/ainterviews.ts — ainterviews.com hosted career boards (e.g. Lenskart).
// GET /api/job_board/<tenant>/jobs/ (no auth, no pagination); full HTML JD inline; apply_url is a relative path.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";

export const AINTERVIEWS_ORIGIN = "https://ainterviews.com";

export const AinterviewsJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  posted_date: z.string().nullable().optional(),
  apply_url: z.string().nullable().optional(),
});
export type AinterviewsJob = z.infer<typeof AinterviewsJobSchema>;

const ListResponseSchema = z.object({ jobs: z.array(AinterviewsJobSchema) });

export function ainterviewsListUrl(tenant: string): string {
  return `${AINTERVIEWS_ORIGIN}/api/job_board/${encodeURIComponent(tenant)}/jobs/`;
}

export function normalizeAinterviews(company: AdapterCompany, j: AinterviewsJob): NormalizedPosting {
  const location = j.location ?? null;
  const jobUrl =
    j.apply_url && /^https?:\/\//i.test(j.apply_url)
      ? j.apply_url
      : j.apply_url
        ? `${AINTERVIEWS_ORIGIN}${j.apply_url}`
        : `${AINTERVIEWS_ORIGIN}/job_board/${company.slug}/`;

  return {
    provider: "ainterviews",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.description),
    postedAt: j.posted_date ?? null,
  };
}

export const ainterviewsAdapter: AtsAdapter = {
  provider: "ainterviews",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = ainterviewsListUrl(company.slug);
    const raw = await atsFetchJson(url, { provider: "ainterviews" });

    const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "ainterviews", slug: company.slug });

    return parsed.jobs.map((j) => normalizeAinterviews(company, j));
  },
  // The list response carries the full description — no fetchJd needed.
};
