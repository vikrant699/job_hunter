// list: GET jobs.api.mercedes-benz.com/search?data=<url-encoded JSON>, filtered by PositionLocation.Country=390 (India)
// requisitions repeat 2-3x per channel under the same PositionID (dedupe on it); no JD in the filtered response, so fetchJd reads the public job page's embedded JSON-LD JobPosting node
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { extractJsonLdJobs } from "../scraper/jsonLd.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const SEARCH_URL = "https://jobs.api.mercedes-benz.com/search";
const PAGE = 50;
const INDIA_COUNTRY_ID = "390";

const FIELDS = [
  "ID",
  "PositionID",
  "PositionTitle",
  "PositionURI",
  "OrganizationName",
  "ParentOrganizationName",
  "PositionLocation.CityName",
  "PositionLocation.DisplayName",
  "PositionLocation.CountryCode",
  "PositionLocation.Country",
  "PublicationStartDate",
  "PositionSchedule.Name",
];

// 1-indexed firstItem.
export function mercedesSearchUrl(firstItem: number, countItem: number): string {
  const query = {
    LanguageCode: "EN",
    SearchParameters: {
      FirstItem: firstItem,
      CountItem: countItem,
      Sort: [{ Criterion: "PositionStartDateInitial", Direction: "DESC" }],
      MatchedObjectDescriptor: FIELDS,
    },
    SearchCriteria: [{ CriterionName: "PositionLocation.Country", CriterionValue: [INDIA_COUNTRY_ID] }],
  };
  return `${SEARCH_URL}?data=${encodeURIComponent(JSON.stringify(query))}`;
}

const MercedesLocationSchema = z.object({
  CityName: z.string().nullable().optional(),
  DisplayName: z.string().nullable().optional(),
});

export const MercedesDescriptorSchema = z.object({
  PositionID: z.string(),
  PositionTitle: z.string(),
  PositionURI: z.string(),
  PositionLocation: z.array(MercedesLocationSchema).nullable().optional(),
  PublicationStartDate: z.string().nullable().optional(),
});
export type MercedesDescriptor = z.infer<typeof MercedesDescriptorSchema>;

const MercedesSearchResponseSchema = z.object({
  SearchResult: z.object({
    SearchResultCountAll: z.number().nullable().optional(),
    SearchResultItems: z.array(z.object({ MatchedObjectDescriptor: MercedesDescriptorSchema })),
  }),
});

export function normalizeMercedes(company: AdapterCompany, d: MercedesDescriptor): NormalizedPosting {
  const loc = d.PositionLocation?.[0];
  const location = loc?.CityName ?? loc?.DisplayName ?? null;
  return {
    provider: "mercedes",
    externalId: d.PositionID,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: d.PositionTitle,
    jobUrl: d.PositionURI,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: dateToIso(d.PublicationStartDate),
  };
}

export function mercedesJdFromHtml(html: string): string {
  const [job] = extractJsonLdJobs(html);
  return job?.description ? htmlToText(job.description) : "";
}

export const mercedesAdapter: AtsAdapter = {
  provider: "mercedes",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await paginate<MercedesDescriptor>({
      provider: "mercedes",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (offset) => {
        const json = await atsFetchJson(mercedesSearchUrl(offset + 1, PAGE), { provider: "mercedes" });
        const parsed = MercedesSearchResponseSchema.parse(json);
        return {
          items: parsed.SearchResult.SearchResultItems.map((i) => i.MatchedObjectDescriptor),
          total: parsed.SearchResult.SearchResultCountAll ?? null,
        };
      },
    });

    // Keep the first-seen row per PositionID so a job isn't multiplied downstream.
    const seen = new Map<string, MercedesDescriptor>();
    for (const d of raw) {
      if (!seen.has(d.PositionID)) seen.set(d.PositionID, d);
    }
    return [...seen.values()].map((d) => normalizeMercedes(company, d));
  },
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "mercedes" });
    return mercedesJdFromHtml(html);
  },
};
