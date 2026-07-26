// src/ats/mercedes.ts — Mercedes-Benz careers (jobs.mercedes-benz.com), backed
// by an HR-Open/USAJobs-style search gateway at jobs.api.mercedes-benz.com.
//
// List: GET https://jobs.api.mercedes-benz.com/search?data=<url-encoded JSON>
//   { LanguageCode, SearchParameters: { FirstItem (1-indexed), CountItem, Sort,
//     MatchedObjectDescriptor: [<fully-qualified field paths>] },
//     SearchCriteria: [{ CriterionName, CriterionValue: [...] }] }
//   -> { SearchResult: { SearchResultCountAll, SearchResultItems: [{
//          MatchedObjectId, MatchedObjectDescriptor: {...} }] } }
//   Filtering by `PositionLocation.Country` (390 = India) was captured from
//   the real frontend by intercepting its window.fetch calls while it loaded
//   facet counts (a *different*, undocumented endpoint from the plain
//   POST /search/en?{page,size} one bare-curl turns up — that one ignores
//   every filter and always returns the full global list, but this one
//   filters correctly). Facet counts on jobs.mercedes-benz.com confirm this
//   matches the site's own "India (150)" count once deduped (see below).
//   Requisitions are published once per channel, so the raw feed repeats each
//   job 2-3x with the same PositionID under different MatchedObjectIds —
//   listPostings dedupes on PositionID.
//
// JD: this filtered endpoint never returns PositionFormattedDescription no
//   matter what fields are requested (confirmed: request it alone, still
//   absent). Instead fetchJd GETs the public job page (PositionURI, which is
//   already a full absolute URL server-rendered by Nuxt) and pulls the body
//   out of its embedded JSON-LD `JobPosting` node.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { tryParseJson, getObj, type JsonValue } from "../util/json.js";
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

/** Build the paged, India-filtered search URL (1-indexed `firstItem`). */
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

function isJobPostingNode(node: JsonValue): node is Record<string, JsonValue> {
  const obj = getObj(node);
  return obj !== null && obj["@type"] === "JobPosting";
}

/** Pull the schema.org JobPosting node out of a job page's JSON-LD island(s).
 *  Nuxt emits one `<script type="application/ld+json">` with an `@graph`
 *  array; tolerates a bare JobPosting object too, and skips blocks that
 *  aren't valid JSON instead of failing the whole page. */
export function extractMercedesJobPosting(html: string): Record<string, JsonValue> | null {
  const re = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    const node = tryParseJson(raw);
    if (node === null) continue;
    if (isJobPostingNode(node)) return node;
    const obj = getObj(node);
    const graph = obj?.["@graph"];
    if (Array.isArray(graph)) {
      const jobPosting = graph.find(isJobPostingNode);
      if (jobPosting) return jobPosting;
    }
  }
  return null;
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

    // The feed republishes each requisition once per channel (2-3x) — keep
    // the first-seen row per PositionID so a job isn't multiplied downstream.
    const seen = new Map<string, MercedesDescriptor>();
    for (const d of raw) {
      if (!seen.has(d.PositionID)) seen.set(d.PositionID, d);
    }
    return [...seen.values()].map((d) => normalizeMercedes(company, d));
  },
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "mercedes" });
    const jobPosting = extractMercedesJobPosting(html);
    const description = jobPosting?.["description"];
    return typeof description === "string" ? htmlToText(description) : "";
  },
};
