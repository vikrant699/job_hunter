// src/ats/consider.ts — Consider.co VC-portfolio job boards (Peak XV / Surge).
//
// One board host serves an entire portfolio; `isParent:false` with a company
// slug narrows it to that company, so each portfolio company is its own
// registry row (same slug-keyed shape as talent500.ts).
//
//   POST <host>/api-boards/search-jobs
//   {"meta":{"size":100,"offset":0},"board":{"id":"<slug>","isParent":false},
//    "query":{"promoteFeatured":true}}
//   -> {total, jobs:[{jobId,title,locations[],companyName,url,applyUrl,
//                     minYearsExp,maxYearsExp,remote,...}]}
//
// Verified live 2026-08-01: jobs.surgeahead.com parent board = 804 jobs across
// 110 companies, 85% India-located; board {id:"meragi",isParent:false} = 23.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import type { JsonValue } from "../util/json.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate, joinLocation } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { JsonValueSchema } from "../util/json.js";

const PAGE = 100;

export const ConsiderJobSchema = z.object({
  jobId: z.union([z.string(), z.number()]),
  title: z.string(),
  locations: z.array(z.string()).nullable().optional(),
  companyName: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  applyUrl: z.string().nullable().optional(),
  minYearsExp: z.number().nullable().optional(),
  maxYearsExp: z.number().nullable().optional(),
  remote: z.boolean().nullable().optional(),
  timeStamp: z.union([z.string(), z.number()]).nullable().optional(),
});
export type ConsiderJob = z.infer<typeof ConsiderJobSchema>;

const ConsiderResponseSchema = z.object({
  total: z.number().optional(),
  jobs: z.array(JsonValueSchema).optional(),
});

/** Request body for one page of one company's jobs. */
export function considerSearchBody(boardId: string, size: number, offset: number): Record<string, JsonValue> {
  return {
    meta: { size, offset },
    board: { id: boardId, isParent: false },
    query: { promoteFeatured: true },
  };
}

export function considerJobsFrom(raw: JsonValue): { jobs: JsonValue[]; total: number } {
  const parsed = ConsiderResponseSchema.safeParse(raw);
  const jobs = parsed.success ? (parsed.data.jobs ?? []) : [];
  const total = parsed.success ? (parsed.data.total ?? jobs.length) : 0;
  return { jobs, total };
}

export function normalizeConsider(company: AdapterCompany, j: ConsiderJob): NormalizedPosting {
  const location = joinLocation(...(j.locations ?? []));
  return {
    provider: "consider",
    externalId: String(j.jobId),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.url ?? j.applyUrl ?? company.careersUrl,
    location,
    isRemote: j.remote === true || (location !== null && REMOTE_RE.test(location)),
    // The list response carries no description; left empty so the relevance
    // gate never sees a truncated JD.
    jdText: "",
    postedAt: typeof j.timeStamp === "string" ? j.timeStamp : null,
  };
}

/** Board id: explicit api_meta.boardId, else the registry slug. */
function boardId(company: AdapterCompany): string {
  const meta = company.apiMeta;
  const fromMeta = meta && typeof meta["boardId"] === "string" ? meta["boardId"] : null;
  return fromMeta ?? company.slug;
}

function searchUrl(company: AdapterCompany): string {
  if (!company.tenantUrl) throw new Error(`consider requires tenant_url (board host) for ${company.slug}`);
  return `${new URL(company.tenantUrl).origin}/api-boards/search-jobs`;
}

export const considerAdapter: AtsAdapter = {
  provider: "consider",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = searchUrl(company);
    const origin = new URL(url).origin;
    return paginate<NormalizedPosting>({
      provider: "consider",
      company: company.slug,
      pageSize: PAGE,
      shortPageEndsPagination: false,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset) => {
        const raw = await atsFetchJson(url, {
          method: "POST",
          body: considerSearchBody(boardId(company), PAGE, offset),
          provider: "consider",
          userAgent: BROWSER_UA,
          headers: { Origin: origin, Referer: `${origin}/jobs` },
        });
        const { jobs, total } = considerJobsFrom(raw);
        const items: NormalizedPosting[] = [];
        for (const r of jobs) {
          const parsed = ConsiderJobSchema.safeParse(r);
          if (parsed.success) items.push(normalizeConsider(company, parsed.data));
        }
        return { items, total, rawCount: jobs.length };
      },
    });
  },
};
