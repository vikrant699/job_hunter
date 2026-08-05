// src/ats/zwayam.ts — Zwayam career boards (e.g. careers.cyient.com,
// careers.cult.fit). Every tenant is on its own custom domain fronting a
// shared Angular SPA, so unlike most adapters there is no common host
// pattern to detect a tenant from — the two tokens the API needs
// (companyId, tenantGroupId) have to be discovered from the tenant's own
// bundle/API and cached in api_meta, same as Keka's orgGuid (companyId is
// discovered from the tenant page's JS bundle at registry-seeding time).
//
//   GET  https://public.zwayam.com/tenant_management/tenant/group?domain_name=<host>
//        -> { reponseObject: { tenantGroupId } }        [sic: vendor typo]
//   POST https://public.zwayam.com/jobs/search  (multipart/form-data)
//        fields: companyId, filterCri (JSON string), domain
//        header: TenantGroupId
//        -> { data: { data: [{ _id, _source: {...} }], totalCount, hasMoreData } }
//
// `domain` — not companyId — is what the vendor keys the tenant on, and that is
// why this adapter needs no dead-tenant marker: a domain Zwayam does not host
// answers HTTP 200 with `data: null`, which fails SearchResponseSchema and so
// fails the row rather than reporting an empty board. A live tenant with nothing
// matching returns `data: { data: [], totalCount: 0 }` and still parses. Probed
// 2026-08-03; zwayam.test.ts pins both shapes so a refactor cannot swallow them.
// A stale companyId does NOT empty the board either (a wrong-but-well-formed value
// returns the domain's own jobs; garbage returns code 500 with data: null).
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

/** The jobs/search filterCri payload for one page. `paginationStartNo` is a row
 *  offset, honoured exactly; there is no page-size field to send, so how many
 *  rows come back is entirely the tenant's business (see listPostings). */
export function zwayamFilterCri(paginationStartNo: number): string {
  return JSON.stringify({
    paginationStartNo,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
}

/** Unwrap one jobs/search page. Throws on a schema mismatch — callers should
 *  let that propagate (a silently-truncated page looks like a complete one).
 *  `slug` defaults to the provider name for callers (tests) with no company
 *  context; the adapter itself passes the real company slug. */
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
      // Tenant-set, not engine-set: careers.livspace.com serves 9 rows per page
      // where careers.cult.fit serves 10, for the identical request (probed live
      // 2026-08-03 across offsets 0/9/10/18/20/27/90/99). Nothing in the body
      // asks for a size, so any constant is a guess about somebody else's
      // tenant — and a guess too high is fatal, because paginate applies the
      // short-page rule BEFORE comparing the reported total: a declared 10 read
      // Livspace's own first page as short and ended the board at 9 of 100,
      // silently, on every run, with totalCount 100 never looked at. Latch the
      // tenant's own first-page row count instead.
      pageSize: "infer",
      // Arms the exact-page-repeat stall guard, whose page signature is built
      // FROM this key. Without it the guard is inert, and a tenant that ignored
      // paginationStartNo would be walked all the way to totalCount re-serving
      // page 1 — 12 pages of JD fetches for 9 real postings on Livspace. The
      // hardcoded size used to mask that by accident (a clamped 9-row page
      // looked short); an inferred one cannot, since page 1 is the yardstick.
      // `_id` is the ES doc id, stable and unique per posting, and matches the
      // (provider, external_id) identity used downstream — so collapsing a
      // cross-page duplicate is correct as well as protective.
      dedupeBy: (p) => p.externalId,
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
