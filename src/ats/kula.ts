import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, joinLocation } from "./shared.js";

// list: GET careers.kula.ai/api/internal/ats_job_posts?accountName=<slug>&page=<n>&items=99 -> { data: AtsJobPost[], meta: { count } }
// one-phase (job_description on every list item); meta.count honored via paginate's total-based stop so larger tenants page fully
const PAGE_SIZE = 99;

const OfficeSchema = z.object({
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
});
const AtsJobSchema = z.object({
  job_description: z.string().nullable().optional(),
  workplace: z.string().nullable().optional(),
  offices: z.array(OfficeSchema).nullable().optional(),
});
const JobPostSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  listed: z.boolean().nullable().optional(),
  ats_job: AtsJobSchema.nullable().optional(),
});
type JobPost = z.infer<typeof JobPostSchema>;
const MetaSchema = z.object({
  count: z.number().nullable().optional(),
  page: z.number().nullable().optional(),
  items: z.number().nullable().optional(),
  pages: z.number().nullable().optional(),
});
const ListResponseSchema = z.object({
  data: z.array(JobPostSchema),
  meta: MetaSchema.nullable().optional(),
});

export function kulaListUrl(slug: string, page: number): string {
  return `https://careers.kula.ai/api/internal/ats_job_posts?accountName=${encodeURIComponent(slug)}&page=${page}&type=ats_job_post.index&items=${PAGE_SIZE}`;
}

export function kulaJobUrl(slug: string, id: string | number): string {
  return `https://careers.kula.ai/${slug}/${id}/`;
}

export const kulaAdapter: AtsAdapter = {
  provider: "kula",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // Board token defaults to the registry slug; apiMeta.boardSlug overrides it when they differ.
    const slug = company.apiMeta?.boardSlug ?? company.slug;
    return paginate<NormalizedPosting>({
      provider: "kula",
      company: slug,
      pageSize: PAGE_SIZE,
      // Kula pages by 1-based page number, not offset — `page` here is paginate's 0-based call index.
      fetchPage: async (_offset, page) => {
        const url = kulaListUrl(slug, page + 1);
        const raw = await atsFetchJson(url, { provider: "kula" });
        const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "kula", slug });
        const rawItems = parsed.data;
        const items = rawItems.filter((j) => j.listed !== false).map((j) => normalizeKula(company, j));
        const total = parsed.meta?.count ?? null;
        return { items, total, rawCount: rawItems.length };
      },
    });
  },
};

export function normalizeKula(company: AdapterCompany, j: JobPost): NormalizedPosting {
  const offices = j.ats_job?.offices ?? [];
  const location =
    offices
      .map((o) => o.location ?? joinLocation(o.city, o.state, o.country) ?? "")
      .filter(Boolean)
      .join("; ") || null;
  const isRemote = j.ats_job?.workplace === "remote" || offices.some((o) => o.remote === true) || (location ? REMOTE_RE.test(location) : false);
  return {
    provider: "kula",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: kulaJobUrl(company.slug, j.id),
    location,
    isRemote,
    jdText: htmlToText(j.ats_job?.job_description ?? ""),
    postedAt: null,
  };
}
