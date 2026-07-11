// src/ats/amazonjobs.ts — Amazon's public jobs search API (www.amazon.jobs).
// Clean JSON search endpoint: GET /en/search.json?country=<cc>&result_limit=N&offset=M&sort=recent
// returns { hits: <total>, jobs: [...] } with the FULL job description inline
// (no per-job fetch needed). result_limit maxes out at 100 on this API.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

const BASE = "https://www.amazon.jobs";
const RESULT_LIMIT = 100; // server max for result_limit
const MAX_PAGES = 50; // safety cap; ~2700 India postings / 100 per page ≈ 27 pages

export const AmazonJobSchema = z.object({
  id_icims: z.string(),
  title: z.string(),
  location: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  job_path: z.string(),
  posted_date: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  description_short: z.string().nullable().optional(),
});
export type AmazonJob = z.infer<typeof AmazonJobSchema>;

const AmazonJobsPageSchema = z.object({
  hits: z.number().nullable().optional(),
  jobs: z.array(AmazonJobSchema),
});

/** Paged search URL; `apiMeta.country` (e.g. "IND") narrows the board, defaults to India. */
export function amazonJobsApiUrl(company: AdapterCompany, offset: number): string {
  const country = company.apiMeta?.country ?? "IND";
  return `${BASE}/en/search.json?country=${encodeURIComponent(country)}&result_limit=${RESULT_LIMIT}&offset=${offset}&sort=recent`;
}

/** Parse one search.json page into its jobs and the reported total (`hits`). */
export function amazonJobsPageJobs(pageJson: unknown): { jobs: AmazonJob[]; total: number | null } {
  const parsed = AmazonJobsPageSchema.parse(pageJson);
  return { jobs: parsed.jobs, total: parsed.hits ?? null };
}

export function normalizeAmazonJobs(company: AdapterCompany, j: AmazonJob): NormalizedPosting {
  const cityCountry = [j.city, j.country_code]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(", ");
  const location = j.location ?? (cityCountry.length > 0 ? cityCountry : null);
  const postedMs = j.posted_date ? Date.parse(j.posted_date) : Number.NaN;
  return {
    provider: "amazonjobs",
    externalId: j.id_icims,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${BASE}${j.job_path}`,
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: htmlToText(j.description ?? j.description_short ?? ""),
    postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
  };
}

export const amazonJobsAdapter: AtsAdapter = {
  provider: "amazonjobs",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "amazonjobs",
      company: company.slug,
      pageSize: RESULT_LIMIT,
      maxPages: MAX_PAGES,
      fetchPage: async (offset) => {
        const json = await atsFetchJson(amazonJobsApiUrl(company, offset), {
          provider: "amazonjobs",
          userAgent: BROWSER_UA,
        });
        const { jobs, total } = amazonJobsPageJobs(json);
        return {
          items: jobs.map((j) => normalizeAmazonJobs(company, j)),
          total,
        };
      },
    });
  },
  // The list response carries the full description — no fetchJd needed.
};
