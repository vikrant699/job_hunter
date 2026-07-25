// src/ats/directemployers.ts — DirectEmployers-network career sites (Nuxt
// shells on `<company>.jobs` domains, backed by the shared jobsyn.org Solr
// search API). Verified live on John Deere (deerecareers.jobs).
//
//   GET https://prod-search-api.jobsyn.org/api/v1/solr/search?page=<N>
//     Header: x-origin: <tenant .jobs domain>   (NOT the standard Origin
//     header — the app reads a custom x-origin; a request without it 403s
//     "Mismatched origin" even from a real browser)
//     -> { jobs: [{ id|guid, title_exact, location_exact|city_exact,
//                   country_exact, description }],
//          pagination: { total, total_pages, has_more_pages } }
//
// apiMeta.origin selects the tenant (the .jobs domain sent as x-origin).
// Optional apiMeta.location narrows the Solr query to a location facet.
// JD is inline in `description`. Paged by page until pagination.total.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, INTER_PAGE_DELAY_MS, sleep, warnDeepPagination } from "./shared.js";

const API = "https://prod-search-api.jobsyn.org/api/v1/solr/search";
const MAX_PAGES = 500;

export const DeJobSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable().optional(),
  guid: z.string().nullable().optional(),
  reqid: z.union([z.string(), z.number()]).nullable().optional(),
  title_exact: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  location_exact: z.string().nullable().optional(),
  city_exact: z.string().nullable().optional(),
  country_exact: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});
export type DeJob = z.infer<typeof DeJobSchema>;

export const DeResponseSchema = z.object({
  jobs: z.array(DeJobSchema),
  pagination: z
    .object({
      total: z.number().nullable().optional(),
      total_pages: z.number().nullable().optional(),
      has_more_pages: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
});

function deOrigin(company: AdapterCompany): string {
  const o = company.apiMeta?.origin;
  if (o) return o;
  // Fall back to the careers host (drop scheme) — DE tenants ARE .jobs hosts.
  try {
    return new URL(company.tenantUrl ?? company.careersUrl).host;
  } catch {
    throw new Error(`directemployers requires apiMeta.origin for ${company.slug}`);
  }
}

export function deSearchUrl(page: number, location: string | null): string {
  const u = new URL(API);
  u.searchParams.set("page", String(page));
  if (location) u.searchParams.set("location", location);
  return u.toString();
}

export function normalizeDeJob(company: AdapterCompany, j: DeJob): NormalizedPosting | null {
  const title = j.title_exact ?? j.title ?? null;
  if (!title) return null;
  const externalId = String(j.guid ?? j.id ?? j.reqid ?? title);
  const joined = [j.city_exact, j.country_exact].filter(Boolean).join(", ");
  const location = j.location_exact ?? (joined || null);
  return {
    provider: "directemployers",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: j.url ?? company.tenantUrl ?? company.careersUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: (j.description ?? "").trim(),
    postedAt: null,
  };
}

export const directemployersAdapter: AtsAdapter = {
  provider: "directemployers",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = deOrigin(company);
    const location = company.apiMeta?.location ?? null;
    const headers = { "x-origin": origin, Accept: "application/json" };

    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    let totalPages = 1;

    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
      const raw = await atsFetchJson(deSearchUrl(page, location), { provider: "directemployers", headers });
      const parsed = DeResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 3) }, "directemployers schema mismatch");
        throw new Error(`directemployers response failed schema for ${company.slug}`);
      }
      totalPages = parsed.data.pagination?.total_pages ?? page;
      for (const j of parsed.data.jobs) {
        const p = normalizeDeJob(company, j);
        if (!p || seen.has(p.externalId)) continue;
        seen.add(p.externalId);
        out.push(p);
      }
      if (parsed.data.jobs.length === 0) break;
      if (page < totalPages) {
        warnDeepPagination("directemployers", company.slug, page, out.length);
        await sleep(INTER_PAGE_DELAY_MS);
      }
    }
    return out;
  },
};
