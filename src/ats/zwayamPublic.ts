// src/ats/zwayamPublic.ts — Zwayam career boards reached via the "public" domain-scoped
// search endpoint, which needs no companyId/tenantGroupId discovery (unlike zwayam.ts's
// header-based flow):
//
//   POST https://public.zwayam.com/jobs/search  (multipart/form-data)
//     fields: filterCri (same shape as zwayam.ts), domain (tenant host)
//     -> { code, data: { data: [{ _id, _source: {...} }], totalCount, hasMoreData } }
//
// POSTing with only filterCri 400s; adding `domain` (no companyId/header) 200s and returns
// that tenant's own jobs. Kept as its own provider/file so zwayam.ts's flow stays untouched.
//
// Tenants are SHARDED across API hosts, and each host answers `data: null` for the other's
// tenants, so the host is per-tenant config (apiMeta.apiHost, default public.zwayam.com).
// Request shape/schema are identical across shards; only the host, served page size (5 vs
// 10), and which location field a tenant populates differ.
//
// One-phase: the JD is inline in _source, same shape/inconsistency as zwayam.ts — no fetchJd needed.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchJsonMultipart, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, epochMsToIso } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";

// The shard most tenants live on. Overridden per company by apiMeta.apiHost.
const DEFAULT_API_HOST = "public.zwayam.com";

// `location` is the tenant's own free-text code as typed into their ATS ("Bangalore", "HO");
// `formattedLocation` is Zwayam's geocoded reading of it. Fields stay optional: this is a
// supplementary source for one field, so a shape drift here must not fail a whole board.
const JobLocationRecordSchema = z.object({
  formattedLocation: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
});

const HitSourceSchema = z.object({
  jobTitle: z.string(),
  jobUrl: z.string().nullable().optional(),
  companyId: z.union([z.string(), z.number()]).nullable().optional(),
  locationSeparatedbySlash: z.string().nullable().optional(),
  jobLocationRecord: z.array(JobLocationRecordSchema).nullable().optional(),
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

// The jobs/search endpoint for this tenant's shard. apiMeta.apiHost is a bare host; absent, the default shard is used.
export function zwayamPublicSearchUrl(company: AdapterCompany): string {
  return `https://${company.apiMeta?.apiHost ?? DEFAULT_API_HOST}/jobs/search`;
}

export function zwayamPublicFilterCri(paginationStartNo: number): string {
  return JSON.stringify({
    paginationStartNo,
    selectedCall: "sort",
    sortCriteria: { name: "modifiedDate", isAscending: false },
    anyOfTheseWords: "",
  });
}

// Unwraps one jobs/search page. Throws on a schema mismatch — callers should let that
// propagate (a silently-truncated page looks complete).
export function zwayamPublicPage(
  raw: JsonValue,
  slug = "zwayam-public",
): { hits: ZwayamPublicHit[]; total: number | null; hasMoreData: boolean } {
  const parsed = parseOrThrow(SearchResponseSchema, raw, { provider: "zwayam-public", slug, what: "page" });
  return {
    hits: parsed.data.data,
    total: parsed.data.totalCount ?? null,
    hasMoreData: parsed.data.hasMoreData ?? false,
  };
}

function bestJdText(src: z.infer<typeof HitSourceSchema>): string {
  const candidates = [
    htmlToText(src.shortDescription ?? ""),
    (src.mediumDescriptionWithoutHtml ?? "").trim(),
    htmlToText(src.mediumDescription ?? ""),
  ];
  return candidates.reduce((best, c) => (c.length > best.length ? c : best), "");
}

// Detail endpoint (same shard host): returns the FULL JD in longDescription, which the
// apic2 shard omits from search hits entirely. Shape captured from the tenant's own Angular detail view.
const DetailResponseSchema = z.object({
  longDescription: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
});

// companyId per registry slug, learned from search hits during listPostings; the detail endpoint requires it.
const companyIdBySlug = new Map<string, string>();

// Whether a raw location code is the tenant's HEAD-OFFICE marker rather than a place.
// Zwayam still geocodes these, landing them on real foreign towns (bare "HO" -> Ho, Volta
// Region, Ghana). Matching is on the CODE, never the geocoded country — a genuinely
// Ghanaian/Japanese posting is legitimate. The bare code matches case-insensitively; the
// "<marker> <office name>" form requires the literal uppercase abbreviation so a real "Ho
// Chi Minh City" code is left alone.
function isHeadOfficeCode(code: string | null | undefined): boolean {
  const trimmed = (code ?? "").trim();
  return trimmed.toUpperCase() === "HO" || /^HO\s/.test(trimmed);
}

// The posting's location from jobLocationRecord: takes the first entry that isn't
// head-office-coded (not entry [0]) since the head-office artefact sometimes sits first
// with the real city second in a multi-entry row.
function recordLocation(records: z.infer<typeof HitSourceSchema>["jobLocationRecord"]): string | null {
  for (const rec of records ?? []) {
    if (isHeadOfficeCode(rec.location)) continue;
    const formatted = (rec.formattedLocation ?? "").trim();
    if (formatted !== "") return formatted;
  }
  return null;
}

// First non-empty path segment of a URL — the tenant path used in the candidate-facing job
// URL. NOT always equal to the registry slug (Max Life Insurance: slug "max-life-insurance",
// tenant path "axismaxlife").
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
  // locationSeparatedbySlash is the shard-dependent field, populated on most of the public
  // shard's postings and almost none of apic2's; it stays preferred where present (every
  // previous run keyed on it), and jobLocationRecord backfills the rest.
  //
  // A null here is deliberate: it routes the posting to the JD-text fallback in
  // lateLocationCheck instead of asserting a location known to be wrong. Same contract as
  // ralphlauren's ungeocoded bucket — do not "fix" it by emitting the geocoded string
  // without checking isHeadOfficeCode first.
  const slashLocation = (src.locationSeparatedbySlash ?? "").trim();
  const location = slashLocation !== "" ? slashLocation : recordLocation(src.jobLocationRecord);
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
      // Tenant-set, not engine-set: the two shards serve 5 and 10 rows for the same
      // request, so any constant would be a guess. Latch the tenant's own first-page row count.
      pageSize: "infer",
      // Arms the exact-page-repeat stall guard: without it a board ignoring
      // paginationStartNo is walked all the way to totalCount re-fetching page 1.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset) => {
        const raw = await atsFetchJsonMultipart(zwayamPublicSearchUrl(company), {
          fields: { filterCri: zwayamPublicFilterCri(offset), domain: host },
          provider: "zwayam-public",
          userAgent: BROWSER_UA,
        });
        const { hits, total } = zwayamPublicPage(raw, company.slug);
        // Remember the tenant's companyId for fetchJd (consistent across hits).
        const cid = hits.find((h) => h._source.companyId !== null && h._source.companyId !== undefined)?._source.companyId;
        if (cid !== undefined && cid !== null) companyIdBySlug.set(company.slug, String(cid));
        return {
          items: hits.map((h) => normalizeZwayamPublic(company, h, origin, tenantPath)),
          total,
          rawCount: hits.length,
        };
      },
    });
  },

  // Called for postings whose search hit carried no usable description (the whole apic2 shard).
  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const companyId = companyIdBySlug.get(company.slug);
    if (companyId === undefined) {
      logger.warn({ slug: company.slug }, "zwayam-public: no companyId learned from search hits; cannot fetch JD");
      return posting.jdText;
    }
    const tenantUrl = company.tenantUrl ?? company.careersUrl;
    const apiHost = company.apiMeta?.apiHost ?? DEFAULT_API_HOST;
    const slug = new URL(posting.jobUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const raw = await atsFetchJson(`https://${apiHost}/jobs-service/v1/jobs/careersite`, {
      provider: "zwayam-public",
      userAgent: BROWSER_UA,
      headers: { Origin: new URL(tenantUrl).origin, Referer: tenantUrl },
      body: { jobUrl: slug, externalSource: "CareerSite", campusUrl: "empty", companyId },
    });
    const parsed = parseOrThrow(DetailResponseSchema, raw, {
      provider: "zwayam-public",
      slug: company.slug,
      what: `detail ${slug}`,
    });
    const jd = htmlToText(parsed.longDescription ?? parsed.shortDescription ?? "");
    return jd !== "" ? jd : posting.jdText;
  },
};
