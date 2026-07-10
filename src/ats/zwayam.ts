// src/ats/zwayam.ts — Zwayam career boards (e.g. careers.cyient.com,
// careers.cult.fit). Every tenant is on its own custom domain fronting a
// shared Angular SPA, so unlike most adapters there is no common host
// pattern to detect a tenant from — the two tokens the API needs
// (companyId, tenantGroupId) have to be discovered from the tenant's own
// bundle/API and cached in api_meta, same as Keka's orgGuid (see
// discoverZwayamMeta in discovery/ats-validate.ts).
//
//   GET  https://public.zwayam.com/tenant_management/tenant/group?domain_name=<host>
//        -> { reponseObject: { tenantGroupId } }        [sic: vendor typo]
//   POST https://public.zwayam.com/jobs/search  (multipart/form-data)
//        fields: companyId, filterCri (JSON string), domain
//        header: TenantGroupId
//        -> { data: { data: [{ _id, _source: {...} }], totalCount, hasMoreData } }
//
// One-phase: the JD is inline in _source. Tenants are inconsistent about
// which field carries it — some put the full HTML JD in shortDescription,
// others leave that near-empty (equal to the title) and only populate
// mediumDescriptionWithoutHtml — so the normalizer picks the longest of
// the three description fields it finds (see bestJdText).
//
// The whole stack (tenant hosts AND public.zwayam.com) is Akamai-fronted and
// resets the connection (ECONNRESET) for non-browser User-Agents — verified
// live. Every fetch here goes out with BROWSER_UA, same as Jibe.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJsonMultipart } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";

const PAGE_SIZE = 10;

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

const TenantGroupResponseSchema = z.object({
  reponseObject: z.object({ tenantGroupId: z.string() }), // vendor typo, verified live
});

/** Extract the base64 COMPANYID constant embedded in the tenant's Angular
 *  bundle (e.g. `const Zs={COMPANYID:"MTU0ODY=",...}`). The variable name
 *  the minifier assigns varies per build, so match on the key alone. */
const COMPANY_ID_RE = /COMPANYID\s*:\s*"([^"]*)"/;
export function extractZwayamCompanyId(bundleJs: string): string | null {
  const id = bundleJs.match(COMPANY_ID_RE)?.[1];
  return id ? id : null;
}

/** Find the Angular main bundle's script src on a Zwayam careers page
 *  (`<script src="main.<hash>.js">`), so it can be fetched and grepped for
 *  the COMPANYID constant. */
const BUNDLE_SRC_RE = /<script[^>]*\ssrc="(main\.[a-z0-9]+\.js)"/i;
export function extractZwayamBundleSrc(html: string): string | null {
  return html.match(BUNDLE_SRC_RE)?.[1] ?? null;
}

/** Shared public.zwayam.com endpoint that maps a tenant's careers host to
 *  its tenantGroupId. */
export function zwayamTenantGroupUrl(host: string): string {
  return `https://public.zwayam.com/tenant_management/tenant/group?domain_name=${encodeURIComponent(host)}`;
}

/** Parse the (typo'd) tenant/group response. Null on any schema mismatch. */
export function parseZwayamTenantGroupId(raw: unknown): string | null {
  const parsed = TenantGroupResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data.reponseObject.tenantGroupId : null;
}

export function zwayamJobsSearchUrl(): string {
  return "https://public.zwayam.com/jobs/search";
}

/** The jobs/search filterCri payload for one page (server-fixed page size 10). */
export function zwayamFilterCri(paginationStartNo: number): string {
  return JSON.stringify({
    paginationStartNo,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
}

/** Unwrap one jobs/search page. Throws on a schema mismatch — callers should
 *  let that propagate (a silently-truncated page looks like a complete one). */
export function zwayamPage(raw: unknown): { hits: ZwayamHit[]; total: number | null; hasMoreData: boolean } {
  const parsed = SearchResponseSchema.parse(raw);
  return {
    hits: parsed.data.data,
    total: parsed.data.totalCount ?? null,
    hasMoreData: parsed.data.hasMoreData ?? false,
  };
}

/** Pick the fullest JD text across the description fields tenants populate
 *  inconsistently (see module doc). shortDescription/mediumDescription carry
 *  HTML; mediumDescriptionWithoutHtml is already plain text. */
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
    postedAt: postedMs ? new Date(postedMs).toISOString() : null,
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
      pageSize: PAGE_SIZE,
      fetchPage: async (offset) => {
        const raw = await atsFetchJsonMultipart(zwayamJobsSearchUrl(), {
          fields: { companyId, filterCri: zwayamFilterCri(offset), domain: host },
          headers: { TenantGroupId: tenantGroupId },
          provider: "zwayam",
          // The whole public.zwayam.com + tenant-host infra is Akamai-fronted
          // and resets the connection for non-browser UAs (verified live) —
          // same shape as Jibe.
          userAgent: BROWSER_UA,
        });
        const { hits, total } = zwayamPage(raw);
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
