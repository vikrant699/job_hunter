// src/ats/apple.ts — Apple Careers (jobs.apple.com) public search API.
//
// List: POST <origin>/api/v1/search
//   body { query, filters: { locations: [postLocationFacetId] }, page, locale,
//          sort, format: { longDate, mediumDate } }
//   -> { res: { searchResults: [...], totalRecords } }
//   Page size is server-fixed at 20. The `sort`/`format` keys are load-bearing:
//   omitting either makes the endpoint silently return zero results (captured
//   from the real jobs.apple.com/en-in SPA via a Playwright network capture —
//   the URL's `?location=india-IND` query param is NOT read server-side, it
//   just seeds the client-side location-picker's initial (and here, wrong —
//   it resolves to "Indianapolis") suggestion).
//   `locations` filter values are opaque facet ids, not country codes; India's
//   is "postLocation-INDC" (confirmed via the same capture).
//   Multi-location postings (isMultiLocation) are listed once per city, each
//   with a distinct `id` (e.g. "200615971-0321") sharing one `positionId` —
//   `id` is what's unique across the result set, so it's used as externalId.
//
// JD: GET <origin>/api/v1/jobDetails/<jobNumber>?locale=<locale>
//   -> { res: { jobSummary, description, minimumQualifications,
//               preferredQualifications, ... } } — jobNumber is the numeric
//   `positionId`, recovered from the details URL built in normalizeApple.
//
// Single fixed India-filtered company; no per-tenant config needed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { matchGroup } from "../util/regex.js";
import type { JsonValue } from "../util/json.js";

const ORIGIN = "https://jobs.apple.com";
const PAGE = 20;
const LOCALE = "en-in";
const INDIA_LOCATION_FACET = "postLocation-INDC";

const AppleLocationSchema = z.object({
  name: z.string().nullable().optional(),
  countryName: z.string().nullable().optional(),
});

export const AppleSearchResultSchema = z.object({
  id: z.string(),
  positionId: z.string(),
  postingTitle: z.string(),
  transformedPostingTitle: z.string(),
  postDateInGMT: z.string().nullable().optional(),
  homeOffice: z.boolean().nullable().optional(),
  locations: z.array(AppleLocationSchema).nullable().optional(),
});
export type AppleSearchResult = z.infer<typeof AppleSearchResultSchema>;

const AppleSearchResponseSchema = z.object({
  res: z.object({
    searchResults: z.array(AppleSearchResultSchema),
    totalRecords: z.number().nullable().optional(),
  }),
});

const AppleJobDetailsResponseSchema = z.object({
  res: z.object({
    jobSummary: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    minimumQualifications: z.string().nullable().optional(),
    preferredQualifications: z.string().nullable().optional(),
  }),
});

/** Build the exact body Apple's SPA sends once its location filter is set to
 *  the India facet — every key here is required (see module header). */
export function appleSearchBody(page: number): JsonValue {
  return {
    query: "",
    filters: { locations: [INDIA_LOCATION_FACET] },
    page,
    locale: LOCALE,
    sort: "",
    format: { longDate: "MMMM D, YYYY", mediumDate: "MMM D, YYYY" },
  };
}

export function normalizeApple(company: AdapterCompany, r: AppleSearchResult): NormalizedPosting {
  const loc = r.locations?.[0];
  const location = loc?.name ?? loc?.countryName ?? null;
  const postedMs = r.postDateInGMT ? Date.parse(r.postDateInGMT) : Number.NaN;
  return {
    provider: "apple",
    externalId: r.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.postingTitle,
    jobUrl: `${ORIGIN}/en-in/details/${r.positionId}/${r.transformedPostingTitle}`,
    location,
    isRemote: r.homeOffice === true || (location ? REMOTE_RE.test(location) : false),
    jdText: "",
    postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
  };
}

/** Recover the numeric jobNumber jobDetails expects from a details URL built
 *  by normalizeApple (".../details/<jobNumber>/<slug>"). */
export function appleJobNumberFromUrl(jobUrl: string): string | null {
  return matchGroup(/\/details\/(\d+)/, jobUrl);
}

/** Join the JD sub-fields Apple splits across the jobDetails response. */
export function appleJdText(d: {
  jobSummary?: string | null;
  description?: string | null;
  minimumQualifications?: string | null;
  preferredQualifications?: string | null;
}): string {
  const body = [d.jobSummary, d.description, d.minimumQualifications, d.preferredQualifications]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n\n");
  return htmlToText(body);
}

export const appleAdapter: AtsAdapter = {
  provider: "apple",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await paginate<AppleSearchResult>({
      provider: "apple",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(`${ORIGIN}/api/v1/search`, {
          method: "POST",
          body: appleSearchBody(page + 1),
          provider: "apple",
        });
        const parsed = AppleSearchResponseSchema.parse(json);
        return {
          items: parsed.res.searchResults,
          total: parsed.res.totalRecords ?? null,
        };
      },
    });
    return raw.map((r) => normalizeApple(company, r));
  },
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const jobNumber = appleJobNumberFromUrl(posting.jobUrl);
    if (!jobNumber) return "";
    const json = await atsFetchJson(`${ORIGIN}/api/v1/jobDetails/${jobNumber}?locale=${LOCALE}`, {
      provider: "apple",
    });
    const parsed = AppleJobDetailsResponseSchema.safeParse(json);
    if (!parsed.success) return "";
    return appleJdText(parsed.data.res);
  },
};
