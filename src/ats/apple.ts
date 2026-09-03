// list: POST /api/v1/search, page size fixed at 20 -> {res.searchResults[]}
// jd: GET /api/v1/jobDetails/<jobNumber>?locale=<locale>, jobNumber is the numeric positionId
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";
import { matchGroup } from "../util/regex.js";
import type { JsonValue } from "../util/json.js";

const ORIGIN = "https://jobs.apple.com";
const PAGE = 20;
const LOCALE = "en-in";
// The locations filter takes Apple's opaque facet ids, not country codes; "postLocation-INDC" is the India facet.
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

// `sort`/`format` keys are load-bearing - omit either and it silently returns zero results
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
  return {
    provider: "apple",
    // Multi-location postings repeat once per city with a distinct r.id sharing one positionId, so r.id is the dedup key.
    externalId: r.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.postingTitle,
    jobUrl: `${ORIGIN}/en-in/details/${r.positionId}/${r.transformedPostingTitle}`,
    location,
    isRemote: r.homeOffice === true || (location ? REMOTE_RE.test(location) : false),
    jdText: "",
    postedAt: dateToIso(r.postDateInGMT),
  };
}

export function appleJobNumberFromUrl(jobUrl: string): string | null {
  return matchGroup(/\/details\/(\d+)/, jobUrl);
}

export function appleJdText(d: {
  jobSummary?: string | null | undefined;
  description?: string | null | undefined;
  minimumQualifications?: string | null | undefined;
  preferredQualifications?: string | null | undefined;
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
