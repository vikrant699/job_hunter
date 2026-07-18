// src/ats/kula.ts
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

// Kula ATS public board API:
//   GET careers.kula.ai/api/internal/ats_job_posts?accountName=<slug>&page=<n>
//       &type=ats_job_post.index&items=99
//   -> { data: AtsJobPost[], meta: { count, page, items, pages }, errors }
// One-phase: `ats_job.job_description` is present on every listing item
// (confirmed identical to the per-posting detail endpoint on avoma id 1912),
// so `fetchJd` is unnecessary. Both verified tenants (avoma: 27, cashfree: 52)
// fit on one page, but `meta.count` is honored via `paginate`'s total-based
// stop so a larger tenant would page correctly rather than being truncated.
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
    // Board token defaults to the registry slug; apiMeta.boardSlug overrides it
    // when they differ (e.g. multiplier -> "usemultiplier", plum -> "plumhq").
    const slug = company.apiMeta?.boardSlug ?? company.slug;
    return paginate<NormalizedPosting>({
      provider: "kula",
      company: slug,
      pageSize: PAGE_SIZE,
      // Kula pages by 1-based page number, not offset — `page` here is
      // paginate's 0-based call index.
      fetchPage: async (_offset, page) => {
        const url = kulaListUrl(slug, page + 1);
        const raw = await atsFetchJson(url, { provider: "kula" });
        const parsed = ListResponseSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ slug, issues: parsed.error.issues.slice(0, 2) }, "kula schema mismatch");
          throw new Error(`kula response failed schema for ${slug}`);
        }
        const rawItems = parsed.data.data;
        const items = rawItems.filter((j) => j.listed !== false).map((j) => normalizeKula(company, j));
        const total = parsed.data.meta?.count ?? null;
        return { items, total, rawCount: rawItems.length };
      },
    });
  },
};

export function normalizeKula(company: AdapterCompany, j: JobPost): NormalizedPosting {
  const offices = j.ats_job?.offices ?? [];
  const location =
    offices
      .map((o) => o.location ?? [o.city, o.state, o.country].map((s) => (s ?? "").trim()).filter(Boolean).join(", "))
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
