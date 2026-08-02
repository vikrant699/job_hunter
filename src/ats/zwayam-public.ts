// src/ats/zwayam-public.ts — Zwayam career boards reached via the "public"
// domain-scoped search endpoint, which needs no companyId/tenantGroupId
// discovery (unlike zwayam.ts's header-based flow):
//
//   POST https://public.zwayam.com/jobs/search  (multipart/form-data)
//     fields: filterCri (JSON string, same shape as zwayam.ts), domain
//             (tenant host, e.g. career.axismaxlife.com)
//     -> { code, data: { data: [{ _id, _source: {...} }], totalCount,
//          hasMoreData } }
//
// Verified live 2026-08-01: POSTing with ONLY filterCri 400s ("Bad
// Request"); adding `domain` (no companyId, no TenantGroupId header) 200s
// and returns that tenant's own jobs (_source.companyId consistent across
// every hit returned). Confirmed against Max Life Insurance
// (career.axismaxlife.com, companyId 15865): totalCount 6350, page size
// fixed at 5 regardless of what's requested (checked offsets 0/5/10).
// This may unblock the 4 existing zwayam.ts tenants previously written off
// as Akamai-blocked during companyId/tenantGroupId discovery — this
// endpoint sidesteps that discovery step entirely. Kept as its own
// provider/file so zwayam.ts (header-based, PAGE_SIZE 10) stays untouched.
//
// Tenants are SHARDED across API hosts, and each host answers `data: null`
// for the other's tenants — so the host is per-tenant config, not a constant
// (`apiMeta.apiHost`, defaulting to public.zwayam.com). Verified live
// 2026-08-02: careers.infoedge.com only on public.zwayam.com, and
// jobs.bajajgeneral.com (360 postings) only on apic2.zwayam.com. Request
// shape, body and response schema are identical on both; only the host and
// the served page size (5 vs 10) differ, hence pageSize "infer" below.
//
// One-phase: the JD is inline in _source, same shape/inconsistency as
// zwayam.ts (see bestJdText) — no fetchJd needed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJsonMultipart, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, epochMsToIso } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

// The shard most tenants live on. Overridden per company by apiMeta.apiHost.
const DEFAULT_API_HOST = "public.zwayam.com";

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
export type ZwayamPublicHit = z.infer<typeof HitSchema>;

const SearchResponseSchema = z.object({
  data: z.object({
    data: z.array(HitSchema),
    totalCount: z.number().nullable().optional(),
    hasMoreData: z.boolean().nullable().optional(),
  }),
});

/** The jobs/search endpoint for this tenant's shard. `apiMeta.apiHost` is a
 *  bare host (e.g. "apic2.zwayam.com"); absent, the default shard is used. */
export function zwayamPublicSearchUrl(company: AdapterCompany): string {
  return `https://${company.apiMeta?.apiHost ?? DEFAULT_API_HOST}/jobs/search`;
}

/** The jobs/search filterCri payload for one page — same shape as zwayam.ts. */
export function zwayamPublicFilterCri(paginationStartNo: number): string {
  return JSON.stringify({
    paginationStartNo,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
}

/** Unwrap one jobs/search page. Throws on a schema mismatch — callers should
 *  let that propagate (a silently-truncated page looks like a complete one). */
export function zwayamPublicPage(
  raw: unknown,
  slug = "zwayam-public",
): { hits: ZwayamPublicHit[]; total: number | null; hasMoreData: boolean } {
  const parsed = parseOrThrow(SearchResponseSchema, raw, { provider: "zwayam-public", slug, what: "page" });
  return {
    hits: parsed.data.data,
    total: parsed.data.totalCount ?? null,
    hasMoreData: parsed.data.hasMoreData ?? false,
  };
}

/** Pick the fullest JD text across the description fields tenants populate
 *  inconsistently (same behavior as zwayam.ts's bestJdText). */
function bestJdText(src: z.infer<typeof HitSourceSchema>): string {
  const candidates = [
    htmlToText(src.shortDescription ?? ""),
    (src.mediumDescriptionWithoutHtml ?? "").trim(),
    htmlToText(src.mediumDescription ?? ""),
  ];
  return candidates.reduce((best, c) => (c.length > best.length ? c : best), "");
}

/** First non-empty path segment of a URL — the tenant path used in the
 *  candidate-facing job URL (…/<tenant>/jobview/<slug>). NOT always equal to
 *  the registry slug: Max Life Insurance's slug is "max-life-insurance" but
 *  its tenant path segment (from career.axismaxlife.com/axismaxlife/) is
 *  "axismaxlife". */
export function zwayamPublicTenantPath(url: string): string {
  const first = new URL(url).pathname.split("/").filter(Boolean)[0];
  if (!first) throw new Error(`zwayam-public: could not derive tenant path from URL "${url}"`);
  return first;
}

export function normalizeZwayamPublic(
  company: AdapterCompany,
  hit: ZwayamPublicHit,
  careersOrigin: string,
  tenantPath: string,
): NormalizedPosting {
  const src = hit._source;
  const location = src.locationSeparatedbySlash ?? null;
  const postedMs = src.createdDate ?? src.jobCreatedDate ?? null;
  const urlSlug = src.jobUrl ?? String(hit._id);
  return {
    provider: "zwayam-public",
    externalId: String(hit._id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: src.jobTitle,
    jobUrl: `${careersOrigin}/${tenantPath}/jobview/${urlSlug}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: bestJdText(src),
    postedAt: epochMsToIso(postedMs),
  };
}

export const zwayamPublicAdapter: AtsAdapter = {
  provider: "zwayam-public",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const tenantUrl = company.tenantUrl ?? company.careersUrl;
    const host = new URL(tenantUrl).host;
    const origin = new URL(tenantUrl).origin;
    const tenantPath = zwayamPublicTenantPath(tenantUrl);

    return paginate<NormalizedPosting>({
      provider: "zwayam-public",
      company: company.slug,
      // Tenant-set, not engine-set: the two shards serve 5 and 10 rows for the
      // same request, so any constant is a guess about somebody else's tenant.
      // paginate checks the short-page rule BEFORE the reported total, so
      // guessing high ends a smaller-serving board on page 1 with totalCount
      // sitting unread. Latch the tenant's own first-page row count instead.
      pageSize: "infer",
      // Arms the exact-page-repeat stall guard, whose page signature is built
      // FROM this key: without it a board that ignores paginationStartNo is
      // walked all the way to totalCount re-fetching page 1 (360 postings'
      // worth of JD fetches for 10 real jobs). `_id` is the ES doc id, stable
      // and unique per posting, and matches the (provider, external_id)
      // identity used downstream — so collapsing a cross-page duplicate is
      // correct as well as protective.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset) => {
        const raw = await atsFetchJsonMultipart(zwayamPublicSearchUrl(company), {
          fields: { filterCri: zwayamPublicFilterCri(offset), domain: host },
          provider: "zwayam-public",
          // Same Akamai-fronted stack as zwayam.ts — rejects non-browser UAs.
          userAgent: BROWSER_UA,
        });
        const { hits, total } = zwayamPublicPage(raw, company.slug);
        return {
          items: hits.map((h) => normalizeZwayamPublic(company, h, origin, tenantPath)),
          total,
          rawCount: hits.length,
        };
      },
    });
  },
};
