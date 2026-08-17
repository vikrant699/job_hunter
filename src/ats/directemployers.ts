// src/ats/directemployers.ts — DirectEmployers-network career sites (Nuxt shells on `<company>.jobs` domains,
// backed by the shared jobsyn.org Solr search API).
// GET prod-search-api.jobsyn.org/api/v1/solr/search?page=<N>, header x-origin: <tenant .jobs domain> is REQUIRED
// (a custom header, not the standard Origin - omitting it 403s "Mismatched origin" even from a real browser).
// apiMeta.origin selects the tenant; JD is inline in `description`.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate } from "./shared.js";

const API = "https://prod-search-api.jobsyn.org/api/v1/solr/search";
const NOMINAL_PAGE_SIZE = 10; // placeholder; pagination is actually driven by pagination.total_pages

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
  // Fall back to the careers host - DE tenants ARE .jobs hosts.
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

    return paginate<NormalizedPosting>({
      provider: "directemployers",
      company: company.slug,
      pageSize: NOMINAL_PAGE_SIZE,
      shortPageEndsPagination: false, // termination is a zero-item page or reaching pagination.total_pages instead
      maxPages: DEFAULT_MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, page) => {
        const currentPage = page + 1; // API is 1-based
        const raw = await atsFetchJson(deSearchUrl(currentPage, location), { provider: "directemployers", headers });
        const parsed = parseOrThrow(DeResponseSchema, raw, {
          provider: "directemployers",
          slug: company.slug,
          what: `list page ${currentPage}`,
        });
        const items = parsed.jobs
          .map((j) => normalizeDeJob(company, j))
          .filter((p): p is NormalizedPosting => p !== null);
        // total_pages is re-read from every response (not latched from page 1); once this page is the last one,
        // `total` is reported as the cumulative offset so paginate() stops right after fetching it.
        const totalPagesNow = parsed.pagination?.total_pages ?? currentPage;
        const isLastPage = currentPage >= totalPagesNow;
        return {
          items,
          rawCount: parsed.jobs.length,
          total: isLastPage ? offset + parsed.jobs.length : null,
        };
      },
    });
  },
};
