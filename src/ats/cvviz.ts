// list: GET api.cvviz.com/public/career-pages/<pageSlug>/jobs?context=employer&page=&pageSize= -> {data[], meta.pagination.totalItems}; no token, description is the full JD
// detail (unused, adds only skills tags): GET api.cvviz.com/public/career-pages/<pageSlug>/jobs/<id>?context=employer
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, joinLocation } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const API = "https://api.cvviz.com/public/career-pages";
const SITE = "https://jobs.cvviz.com";
const PAGE = 100; // the API's maximum; larger sizes are rejected with 400.

const CvvizLocationSchema = z.object({
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  remote: z.boolean().nullable().optional(),
});
type CvvizLocation = z.infer<typeof CvvizLocationSchema>;

export const CvvizJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  description: z.string().nullable().optional(),
  location: CvvizLocationSchema.nullable().optional(),
  publication: z.object({ createdAt: z.string().nullable().optional() }).nullable().optional(),
});
export type CvvizJob = z.infer<typeof CvvizJobSchema>;

const ListResponseSchema = z.object({
  data: z.array(CvvizJobSchema),
  meta: z
    .object({ pagination: z.object({ totalItems: z.number().nullable().optional() }).nullable().optional() })
    .nullable()
    .optional(),
});

export function cvvizPageSlug(company: AdapterCompany): string {
  try {
    const seg = new URL(company.tenantUrl ?? company.careersUrl).pathname.split("/").filter(Boolean)[0];
    if (seg) return seg;
  } catch {
    return company.slug;
  }
  return company.slug;
}

export function cvvizJobsUrl(pageSlug: string, page: number, pageSize: number): string {
  return `${API}/${encodeURIComponent(pageSlug)}/jobs?context=employer&page=${page}&pageSize=${pageSize}`;
}

export function cvvizJobUrl(pageSlug: string, id: string, title: string): string {
  const titlePart = title.split(" ").join("_").replace(/\//g, "-");
  return `${SITE}/${encodeURIComponent(pageSlug)}/${encodeURIComponent(`job_${id}_${titlePart}`)}`;
}

export function cvvizLocation(loc: CvvizLocation | null | undefined): string | null {
  if (!loc) return null;
  return joinLocation(loc.city, loc.state, loc.country);
}

export function normalizeCvviz(company: AdapterCompany, pageSlug: string, j: CvvizJob): NormalizedPosting {
  const location = cvvizLocation(j.location);
  return {
    provider: "cvviz",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: cvvizJobUrl(pageSlug, j.id, j.title),
    location,
    isRemote: j.location?.remote === true || (location ? REMOTE_RE.test(location) : false),
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.publication?.createdAt ?? null,
  };
}

export interface CvvizPage {
  postings: NormalizedPosting[];
  total: number | null;
}

export function parseCvvizPage(company: AdapterCompany, pageSlug: string, raw: JsonValue): CvvizPage {
  const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "cvviz", slug: company.slug });
  return {
    postings: parsed.data.map((j) => normalizeCvviz(company, pageSlug, j)),
    total: parsed.meta?.pagination?.totalItems ?? null,
  };
}

export const cvvizAdapter: AtsAdapter = {
  provider: "cvviz",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const pageSlug = cvvizPageSlug(company);
    return paginate<NormalizedPosting>({
      provider: "cvviz",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(cvvizJobsUrl(pageSlug, page + 1, PAGE), { provider: "cvviz" });
        const { postings, total } = parseCvvizPage(company, pageSlug, raw);
        return { items: postings, total };
      },
    });
  },
};
