// src/ats/jibe.ts — Jibe (iCIMS CX) career sites, e.g. careers.se.com.
// Clean JSON search API: GET <host>/api/jobs?page=N[&location=...] returns
// { jobs: [{ data: {...} }], totalCount } in server-fixed pages (10 on the
// tenants seen so far — page-size params are ignored, so the loop infers the
// size from page 1), with the FULL job description inline (no per-job fetch
// needed). The WAF in front of these
// sites 403s non-browser user agents, so requests go out with the browser UA.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

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

/** Paged search URL; `apiMeta.location` (e.g. "India") narrows server-side. */
export function jibeApiUrl(company: AdapterCompany, page: number): string {
  const location = company.apiMeta?.location;
  const filter = location ? `&location=${encodeURIComponent(location)}` : "";
  return `${tenantOrigin(company)}/api/jobs?page=${page}${filter}`;
}

/** Unwrap the `jobs[].data` envelope; tolerates a missing totalCount. */
export function jibePageJobs(pageJson: unknown): { jobs: JibeJob[]; totalCount: number | null } {
  const parsed = JibePageSchema.parse(pageJson);
  return { jobs: parsed.jobs.map((j) => j.data), totalCount: parsed.totalCount ?? null };
}

export function normalizeJibe(company: AdapterCompany, j: JibeJob): NormalizedPosting {
  const slug = String(j.slug);
  const location = j.full_location ?? j.short_location ?? j.location_name ?? j.country ?? null;
  return {
    provider: "jibe",
    externalId: slug,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.meta_data?.canonical_url ?? `${tenantOrigin(company)}/jobs/${slug}`,
    location,
    isRemote: REMOTE_RE.test(`${j.location_type ?? ""} ${location ?? ""}`),
    jdText: j.description ? htmlToText(j.description) : "",
    postedAt: dateToIso(j.posted_date),
  };
}

export const jibeAdapter: AtsAdapter = {
  provider: "jibe",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "jibe",
      company: company.slug,
      // Page-size params are ignored by this API, so a declared 10 was an
      // assumption about the engine, not something the tenant told us. It also
      // could not be rescued by `totalCount`: paginate checks the short-page
      // rule BEFORE the total, so a tenant serving fewer than 10 stopped at
      // page 1 with the real total sitting unread. Latch the first page's own
      // size instead.
      pageSize: "infer",
      // `totalCount` is optional on this API. When it is absent and every page
      // is full, the exact-page-repeat stall guard is the only terminator left
      // for a board that ignores `page` — and it needs a stable per-item key
      // to recognise the repeat. Cross-page duplicates are dropped as a side
      // effect, which matches the (provider, external_id) identity used
      // downstream.
      dedupeBy: (p) => p.externalId,
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
