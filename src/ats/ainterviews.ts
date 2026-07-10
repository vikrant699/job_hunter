// src/ats/ainterviews.ts — ainterviews.com hosted career boards (e.g. Lenskart).
// Clean JSON API, no auth, no pagination:
//
//   list: GET https://ainterviews.com/api/job_board/<tenant>/jobs/
//         -> { jobs: [ { id, title, description(HTML), location, apply_url, ... } ], filters: {...} }
//
// The list response already carries the full HTML JD, so jdText is populated
// here and no fetchJd is needed. `apply_url` is a site-relative path
// ("/job_board/<tenant>/job/<id>/"); it's resolved against the fixed
// ainterviews.com origin (the host is the same for every tenant — the tenant
// only varies the path).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
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

/** Board list URL for a tenant slug, e.g. "lenskart_ho". */
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

    const parsed = ListResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { slug: company.slug, issues: parsed.error.issues.slice(0, 2) },
        "ainterviews list schema mismatch",
      );
      throw new Error(`ainterviews list response failed schema for ${company.slug}`);
    }

    return parsed.data.jobs.map((j) => normalizeAinterviews(company, j));
  },
  // The list response carries the full description — no fetchJd needed.
};
