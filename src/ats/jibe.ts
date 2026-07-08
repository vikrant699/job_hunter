// src/ats/jibe.ts — Jibe (iCIMS CX) career sites, e.g. careers.se.com.
// Clean JSON search API: GET <host>/api/jobs?page=N[&location=...] returns
// { jobs: [{ data: {...} }], totalCount } in fixed pages of 10, with the FULL
// job description inline (no per-job fetch needed). The WAF in front of these
// sites 403s non-browser user agents, so requests go out with the browser UA.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

const PAGE = 10; // server-fixed; page-size params are ignored

export const JibeJobSchema = z.object({
  slug: z.union([z.string(), z.number()]),
  req_id: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  full_location: z.string().nullable().optional(),
  short_location: z.string().nullable().optional(),
  location_name: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  location_type: z.string().nullable().optional(),
  posted_date: z.string().nullable().optional(),
  meta_data: z.object({ canonical_url: z.string().nullable().optional() }).nullable().optional(),
});
export type JibeJob = z.infer<typeof JibeJobSchema>;

const JibePageSchema = z.object({
  jobs: z.array(z.object({ data: JibeJobSchema })),
  totalCount: z.number().nullable().optional(),
});

function siteOrigin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/** Paged search URL; `apiMeta.location` (e.g. "India") narrows server-side. */
export function jibeApiUrl(company: AdapterCompany, page: number): string {
  const location = company.apiMeta?.location;
  const filter = location ? `&location=${encodeURIComponent(location)}` : "";
  return `${siteOrigin(company)}/api/jobs?page=${page}${filter}`;
}

/** Unwrap the `jobs[].data` envelope; tolerates a missing totalCount. */
export function jibePageJobs(pageJson: unknown): { jobs: JibeJob[]; totalCount: number | null } {
  const parsed = JibePageSchema.parse(pageJson);
  return { jobs: parsed.jobs.map((j) => j.data), totalCount: parsed.totalCount ?? null };
}

export function normalizeJibe(company: AdapterCompany, j: JibeJob): NormalizedPosting {
  const slug = String(j.slug);
  const location = j.full_location ?? j.short_location ?? j.location_name ?? j.country ?? null;
  const postedMs = j.posted_date ? Date.parse(j.posted_date) : Number.NaN;
  return {
    provider: "jibe",
    externalId: slug,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.meta_data?.canonical_url ?? `${siteOrigin(company)}/jobs/${slug}`,
    location,
    isRemote: REMOTE_RE.test(`${j.location_type ?? ""} ${location ?? ""}`),
    jdText: j.description ? htmlToText(j.description) : "",
    postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
  };
}

export const jibeAdapter: AtsAdapter = {
  provider: "jibe",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "jibe",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(jibeApiUrl(company, page + 1), {
          provider: "jibe",
          userAgent: BROWSER_UA,
        });
        const { jobs, totalCount } = jibePageJobs(json);
        return {
          items: jobs.map((j) => normalizeJibe(company, j)),
          total: totalCount,
          rawCount: jobs.length,
        };
      },
    });
  },
  // The list response carries the full description — no fetchJd needed.
};
