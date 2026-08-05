// src/ats/feishu.ts
//
// Feishu Hire (ByteDance's recruiting platform) public careers API. Each tenant
// is configured via api_meta: the API base + the friendly job-URL base. No auth
// (the /public/supplier endpoints are open); the only required header is
// `website-path` (locale segment). ByteDance itself is the first tenant:
//   apiBase    = https://jobs.bytedance.com/api/v1/public/supplier
//   jobUrlBase = https://jobs.bytedance.com/en/position
//
//   list: POST <apiBase>/search/job/posts
//     body { recruitment_id_list, job_category_id_list, subject_id_list,
//            location_code_list, keyword, limit, offset }
//     -> { code, data: { job_post_list: [{ id, title, description, requirement,
//                        city_info }], count } }   (JD inline)
//   jobUrl: <jobUrlBase>/<id>/detail
//
// `locationCodes` (api_meta, comma-separated Feishu city codes, e.g. "CT_44"
// for Gurgaon) scopes the search server-side to the tenant's India cities;
// empty => all locations.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const PAGE = 50;

export interface FeishuMeta {
  apiBase: string;
  jobUrlBase: string;
  websitePath: string;
  locationCodes: string[];
}

function meta(company: AdapterCompany): FeishuMeta {
  const apiBase = company.apiMeta?.apiBase;
  const jobUrlBase = company.apiMeta?.jobUrlBase;
  if (!apiBase) throw new Error(`feishu adapter requires apiMeta.apiBase for ${company.slug}`);
  if (!jobUrlBase) throw new Error(`feishu adapter requires apiMeta.jobUrlBase for ${company.slug}`);
  const codes = (company.apiMeta?.locationCodes ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  return { apiBase, jobUrlBase, websitePath: company.apiMeta?.websitePath ?? "en", locationCodes: codes };
}

// city_info is a recursive city -> state -> country chain (each with en_name).
interface CityNode { en_name?: string | null | undefined; parent?: CityNode | null | undefined }
const CitySchema: z.ZodType<CityNode> = z.lazy(() =>
  z.object({ en_name: z.string().nullable().optional(), parent: CitySchema.nullable().optional() }),
);
const JobPostSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  requirement: z.string().nullable().optional(),
  city_info: CitySchema.nullable().optional(),
});
export type FeishuJobPost = z.infer<typeof JobPostSchema>;
const ResponseSchema = z.object({
  code: z.number().nullable().optional(),
  data: z.object({
    job_post_list: z.array(JobPostSchema).nullable().optional(),
    count: z.number().nullable().optional(),
  }),
});

/** Flatten the city -> state -> country chain into "City, State, Country". */
export function feishuLocation(city: CityNode | null | undefined): string | null {
  const parts: string[] = [];
  for (let node = city; node; node = node.parent ?? undefined) {
    const name = node.en_name?.trim();
    if (name) parts.push(name);
  }
  return parts.length ? parts.join(", ") : null;
}

export function normalizeFeishu(company: AdapterCompany, m: FeishuMeta, j: FeishuJobPost): NormalizedPosting {
  const location = feishuLocation(j.city_info);
  const jd = [j.description ?? "", j.requirement ?? ""].filter((s) => s.trim()).join("\n\n");
  return {
    provider: "feishu",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${m.jobUrlBase}/${j.id}/detail`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(jd),
    postedAt: null,
  };
}

export const feishuAdapter: AtsAdapter = {
  provider: "feishu",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const m = meta(company);
    const url = `${m.apiBase}/search/job/posts`;
    return paginate<NormalizedPosting>({
      provider: "feishu",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (offset) => {
        const raw = await atsFetchJson(url, {
          method: "POST",
          provider: "feishu",
          headers: { "website-path": m.websitePath },
          body: {
            recruitment_id_list: [],
            job_category_id_list: [],
            subject_id_list: [],
            location_code_list: m.locationCodes,
            keyword: "",
            limit: PAGE,
            offset,
          },
        });
        const parsed = parseOrThrow(ResponseSchema, raw, {
          provider: "feishu",
          slug: company.slug,
          what: `search (offset ${offset})`,
        });
        const list = parsed.data.job_post_list ?? [];
        return { items: list.map((j) => normalizeFeishu(company, m, j)), total: parsed.data.count ?? null };
      },
    });
  },
};
