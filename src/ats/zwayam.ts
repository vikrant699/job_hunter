// list: POST https://public.zwayam.com/jobs/search (multipart/form-data: companyId, filterCri, domain; header TenantGroupId, discovered via GET .../tenant_management/tenant/group?domain_name=<host> -> { reponseObject: { tenantGroupId } } [sic]) -> { data: { data: [{ _id, _source }], totalCount, hasMoreData } }; one-phase (JD inline in _source, see bestJdText).
// `domain` (not companyId) is what the vendor keys the tenant on - an unhosted domain returns data:null and fails the row, but a stale companyId silently returns the domain's own jobs instead of emptying the board.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJsonMultipart, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, epochMsToIso } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";

const HitSourceSchema = z.object({
  jobTitle: z.string(),
  jobUrl: z.string().nullable().optional(),
  locationSeparatedbySlash: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  mediumDescription: z.string().nullable().optional(),
  mediumDescriptionWithoutHtml: z.string().nullable().optional(),
  createdDate: z.number().nullable().optional(),
  jobCreatedDate: z.number().nullable().optional(),
});
const HitSchema = z.object({
  _id: z.union([z.string(), z.number()]),
  _source: HitSourceSchema,
});
export type ZwayamHit = z.infer<typeof HitSchema>;

const SearchResponseSchema = z.object({
  data: z.object({
    data: z.array(HitSchema),
    totalCount: z.number().nullable().optional(),
    hasMoreData: z.boolean().nullable().optional(),
  }),
});

export function zwayamJobsSearchUrl(): string {
  return "https://public.zwayam.com/jobs/search";
}

// The jobs/search filterCri payload for one page; paginationStartNo is a row offset, honoured exactly - there is no page-size field, so row count is entirely the tenant's business.
export function zwayamFilterCri(paginationStartNo: number): string {
  return JSON.stringify({
    paginationStartNo,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
}

// Unwraps one jobs/search page. Throws on a schema mismatch — a silently-truncated page looks complete.
export function zwayamPage(
  raw: JsonValue,
  slug = "zwayam",
): { hits: ZwayamHit[]; total: number | null; hasMoreData: boolean } {
  const parsed = parseOrThrow(SearchResponseSchema, raw, { provider: "zwayam", slug, what: "page" });
  return {
    hits: parsed.data.data,
    total: parsed.data.totalCount ?? null,
    hasMoreData: parsed.data.hasMoreData ?? false,
  };
}

// Picks the fullest JD text across the description fields tenants populate inconsistently.
function bestJdText(src: z.infer<typeof HitSourceSchema>): string {
  const candidates = [
    htmlToText(src.shortDescription ?? ""),
    (src.mediumDescriptionWithoutHtml ?? "").trim(),
    htmlToText(src.mediumDescription ?? ""),
  ];
  return candidates.reduce((best, c) => (c.length > best.length ? c : best), "");
}

export function normalizeZwayam(
  company: AdapterCompany,
  hit: ZwayamHit,
  careersOrigin: string,
  tenant: string,
): NormalizedPosting {
  const src = hit._source;
  const location = src.locationSeparatedbySlash ?? null;
  const postedMs = src.createdDate ?? src.jobCreatedDate ?? null;
  const urlSlug = src.jobUrl ?? String(hit._id);
  return {
    provider: "zwayam",
    externalId: String(hit._id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: src.jobTitle,
    jobUrl: `${careersOrigin}/${tenant}/jobview/${urlSlug}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: bestJdText(src),
    postedAt: epochMsToIso(postedMs),
  };
}

export const zwayamAdapter: AtsAdapter = {
  provider: "zwayam",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const companyId = company.apiMeta?.companyId;
    const tenantGroupId = company.apiMeta?.tenantGroupId;
    if (!companyId || !tenantGroupId) {
      throw new Error(`zwayam adapter requires apiMeta.companyId + apiMeta.tenantGroupId for ${company.slug}`);
    }
    const host = new URL(company.careersUrl).host;
    const origin = new URL(company.careersUrl).origin;

    return paginate<NormalizedPosting>({
      provider: "zwayam",
      company: company.slug,
      // Tenant-set, not engine-set: different tenants serve different row counts for the identical request, and paginate applies the short-page rule before the reported total - a guessed constant too high can end a board early, so latch the tenant's own first-page row count instead.
      pageSize: "infer",
      // Arms the exact-page-repeat stall guard: without it a tenant ignoring paginationStartNo would be walked all the way to totalCount re-serving page 1.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset) => {
        // Akamai-fronted; resets the connection for non-browser User-Agents, same as Jibe.
        const raw = await atsFetchJsonMultipart(zwayamJobsSearchUrl(), {
          fields: { companyId, filterCri: zwayamFilterCri(offset), domain: host },
          headers: { TenantGroupId: tenantGroupId },
          provider: "zwayam",
          userAgent: BROWSER_UA,
        });
        const { hits, total } = zwayamPage(raw, company.slug);
        return {
          items: hits.map((h) => normalizeZwayam(company, h, origin, company.slug)),
          total,
          rawCount: hits.length,
        };
      },
    });
  },
  // The list response carries the full description — no fetchJd needed.
};
