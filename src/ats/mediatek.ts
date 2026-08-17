// src/ats/mediatek.ts — MediaTek careers (custom Next.js + tRPC API).
// GET /api/trpc/job.getJobs?batch=1&input=<urlencoded JSON> returns
// [{ result: { data: { json: { status, jobs:[...], pagination } } } }].
// There is no "India" location filter and no location field on job objects —
// India postings are reached by querying one request PER CITY CODE (locations
// filter), tagging each result with the queried city, and deduping by job id
// across cities. Bare-curl clean, no cookie needed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { paginate, tenantOrigin, dateToIso } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const TRPC_PATH = "/api/trpc/job.getJobs";
const PAGE_LIMIT = 100;

// India city codes: Bangalore, Noida, Mumbai.
export const DEFAULT_MEDIATEK_CITY_CODES = ["0000168800", "0000009297", "9021"];

// Job objects carry no usable location field; tag postings with the queried city instead.
const CITY_LABELS: Record<string, string> = {
  "0000168800": "Bangalore",
  "0000009297": "Noida",
  "9021": "Mumbai",
};

function cityLabel(code: string): string {
  return CITY_LABELS[code] ?? code;
}

// apiMeta.cityCodes is a comma-separated list (Record<string,string> can't hold an array).
export function mediatekCityCodes(company: AdapterCompany): string[] {
  const raw = company.apiMeta?.cityCodes;
  if (!raw) return DEFAULT_MEDIATEK_CITY_CODES;
  const codes = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return codes.length > 0 ? codes : DEFAULT_MEDIATEK_CITY_CODES;
}

const MediatekJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  publishedDate: z.string().nullable().optional(),
});
export type MediatekJob = z.infer<typeof MediatekJobSchema>;

const MediatekPaginationSchema = z.object({
  current_page: z.number().nullable().optional(),
  total_pages: z.number().nullable().optional(),
  total_items: z.number().nullable().optional(),
});

const MediatekResponseSchema = z.array(
  z.object({
    result: z.object({
      data: z.object({
        json: z.object({
          status: z.string().optional(),
          jobs: z.array(MediatekJobSchema),
          pagination: MediatekPaginationSchema.nullable().optional(),
        }),
      }),
    }),
  }),
);

export function mediatekApiUrl(company: AdapterCompany, cityCode: string, page: number, limit = PAGE_LIMIT): string {
  const input = {
    "0": {
      json: {
        locales: "en_US",
        page,
        jobQueryInfo: {},
        filters: { categorys: [], workExperiences: [], locations: [cityCode], programs: [] },
        sortBy: "publishedDate",
        order: "DESC",
        limit,
      },
    },
  };
  return `${tenantOrigin(company)}${TRPC_PATH}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
}

export function mediatekPageJobs(pageJson: JsonValue): { jobs: MediatekJob[]; totalItems: number | null } {
  const parsed = MediatekResponseSchema.parse(pageJson);
  const first = parsed[0];
  const json = first?.result.data.json;
  return { jobs: json?.jobs ?? [], totalItems: json?.pagination?.total_items ?? null };
}

export function normalizeMediatek(company: AdapterCompany, j: MediatekJob, queriedCityCode: string): NormalizedPosting {
  return {
    provider: "mediatek",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${tenantOrigin(company)}/en/jobs/${j.id}`,
    location: cityLabel(queriedCityCode),
    isRemote: false,
    jdText: j.description ? htmlToText(j.description) : "",
    postedAt: dateToIso(j.publishedDate),
  };
}

export const mediatekAdapter: AtsAdapter = {
  provider: "mediatek",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const cityCodes = mediatekCityCodes(company);
    const seen = new Set<string>();
    const out: NormalizedPosting[] = [];

    for (const cityCode of cityCodes) {
      const cityPostings = await paginate<NormalizedPosting>({
        provider: "mediatek",
        company: company.slug,
        pageSize: PAGE_LIMIT,
        fetchPage: async (_offset, page) => {
          const json = await atsFetchJson(mediatekApiUrl(company, cityCode, page + 1), { provider: "mediatek" });
          const { jobs, totalItems } = mediatekPageJobs(json);
          return {
            items: jobs.map((j) => normalizeMediatek(company, j, cityCode)),
            total: totalItems,
            rawCount: jobs.length,
          };
        },
      });
      for (const p of cityPostings) {
        if (seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
    }
    return out;
  },
  // The list response carries the full description inline — no fetchJd needed.
};
