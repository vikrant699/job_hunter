// list: GET <host>/api/jobs?page=N -> { jobs: [{data}], totalCount }, full JD inline (no per-job fetch)
// page size is server-fixed (10 seen so far, ignores any size param — inferred from page 1); WAF 403s non-browser UAs
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";

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
export function jibePageJobs(pageJson: JsonValue): { jobs: JibeJob[]; totalCount: number | null } {
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
      // Page-size params are ignored; short-page checks run before totalCount, so infer size from page 1.
      pageSize: "infer",
      // totalCount is optional; when absent with full pages, the exact-page-repeat stall guard is the only terminator for a board that ignores `page`, and it needs this stable key.
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
