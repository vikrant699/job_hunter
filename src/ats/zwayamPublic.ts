// list: POST https://public.zwayam.com/jobs/search (multipart/form-data: filterCri as in zwayam.ts, domain = tenant host; no companyId/header) -> { code, data: { data: [{ _id, _source }], totalCount, hasMoreData } }.
// filterCri alone 400s; adding `domain` (no companyId) returns that tenant's own jobs.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchJsonMultipart, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, epochMsToIso } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";

// Tenants are SHARDED across hosts (overridden by apiMeta.apiHost); each host answers data:null for the other's tenants.
const DEFAULT_API_HOST = "public.zwayam.com";

// `location` is the tenant's free-text code ("Bangalore", "HO"); `formattedLocation` is Zwayam's geocoded reading. Optional so shape drift can't fail a whole board.
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

// Same shard host; returns the FULL JD in longDescription, which the apic2 shard omits from search hits.
const DetailResponseSchema = z.object({
  longDescription: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
});

// The detail endpoint requires companyId, learned from search hits during listPostings.
const companyIdBySlug = new Map<string, string>();

// Head-office marker, not a place: Zwayam geocodes these onto real foreign towns (bare "HO" -> Ho, Ghana), so match on the CODE, never the geocoded country; the bare code is case-insensitive, but "<marker> <office name>" needs the literal uppercase abbreviation so "Ho Chi Minh City" is left alone.
function isHeadOfficeCode(code: string | null | undefined): boolean {
  const trimmed = (code ?? "").trim();
  return trimmed.toUpperCase() === "HO" || /^HO\s/.test(trimmed);
}

// Takes the first entry that isn't head-office-coded (not entry [0]): the head-office artefact sometimes sits first.
function recordLocation(records: z.infer<typeof HitSourceSchema>["jobLocationRecord"]): string | null {
  for (const rec of records ?? []) {
    if (isHeadOfficeCode(rec.location)) continue;
    const formatted = (rec.formattedLocation ?? "").trim();
    if (formatted !== "") return formatted;
  }
  return null;
}

// NOT always equal to the registry slug (Max Life Insurance: slug "max-life-insurance", tenant path "axismaxlife").
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
  // locationSeparatedbySlash is shard-dependent (most public-shard postings, almost none of apic2's); jobLocationRecord backfills the rest.
  // A null here is deliberate: it routes to lateLocationCheck's JD-text fallback instead of asserting a wrong location; don't "fix" it by emitting the geocoded string without checking isHeadOfficeCode.
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
      // Tenant-set: the two shards serve 5 and 10 rows for the same request, so latch the first-page row count.
      pageSize: "infer",
      // Arms the stall guard: a board ignoring paginationStartNo would otherwise be walked to totalCount re-fetching page 1.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset) => {
        const raw = await atsFetchJsonMultipart(zwayamPublicSearchUrl(company), {
          fields: { filterCri: zwayamPublicFilterCri(offset), domain: host },
          provider: "zwayam-public",
          userAgent: BROWSER_UA,
        });
        const { hits, total } = zwayamPublicPage(raw, company.slug);
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
