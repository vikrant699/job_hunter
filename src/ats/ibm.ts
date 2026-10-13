// List: POST www-api.ibm.com/search/api/v2 {appId:"careers",scopes:["careers2"]} (Elasticsearch passthrough; size<=100, from-paged, country=field_keyword_05).
// Detail: same endpoint, term field_text_01=<jobId>, _source ["body"] (careers.ibm.com job pages sit behind an AWS WAF challenge).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { logger } from "../logger.js";
import { atsFetchJson, parseOrNull, parseOrThrow } from "./http.js";
import { collapseWs, joinLocation, paginate } from "./shared.js";

const SEARCH_URL = "https://www-api.ibm.com/search/api/v2";
export const IBM_PAGE_SIZE = 100;
const QUERY_FIELDS = ["keywords^1", "body^1", "url^2", "description^2", "h1s_content^2", "title^3", "field_text_01"];
const LIST_SOURCE = ["title", "url", "field_text_01", "field_keyword_05", "field_keyword_17", "field_keyword_19"];

const IbmHitSchema = z.object({
  _source: z.object({
    title: z.string(),
    url: z.string().url(),
    field_text_01: z.number().int(),
    field_keyword_05: z.string().optional(),
    field_keyword_17: z.string().optional(),
    field_keyword_19: z.string().optional(),
  }),
});
type IbmHit = z.infer<typeof IbmHitSchema>;

const IbmListSchema = z.object({
  hits: z.object({ total: z.object({ value: z.number() }), hits: z.array(IbmHitSchema) }),
});

const IbmDetailSchema = z.object({
  hits: z.object({ hits: z.array(z.object({ _source: z.object({ body: z.string().optional() }) })) }),
});

export interface IbmScope {
  query: string | null;
  country: string | null;
}

export function ibmListBody(scope: IbmScope, from: number) {
  return {
    appId: "careers",
    scopes: ["careers2"],
    query: {
      bool: {
        must: scope.query ? [{ simple_query_string: { query: scope.query, fields: QUERY_FIELDS } }] : [],
        ...(scope.country ? { filter: [{ term: { field_keyword_05: scope.country } }] } : {}),
      },
    },
    size: IBM_PAGE_SIZE,
    from,
    sort: [{ _id: "asc" }],
    lang: "zz",
    _source: LIST_SOURCE,
  };
}

export function ibmDetailBody(jobId: number) {
  return {
    appId: "careers",
    scopes: ["careers2"],
    query: { bool: { must: [], filter: [{ term: { field_text_01: jobId } }] } },
    size: 1,
    lang: "zz",
    _source: ["body"],
  };
}

// field_keyword_19 is "City, ISO2" or a placeholder ("Multiple Cities", "No City, US"); the country name rides in field_keyword_05.
export function ibmLocation(raw: string, country: string): string | null {
  const city = raw.replace(/,\s*[A-Z]{2}$/, "").trim();
  return joinLocation(/^no city$/i.test(city) ? null : city, country);
}

export const ibmAdapter: AtsAdapter = {
  provider: "ibm",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const scope: IbmScope = { query: company.apiMeta?.query ?? null, country: company.apiMeta?.country ?? null };
    const hits = await paginate<IbmHit>({
      provider: "ibm",
      company: company.slug,
      pageSize: IBM_PAGE_SIZE,
      dedupeBy: (h) => String(h._source.field_text_01),
      fetchPage: async (offset) => {
        const raw = await atsFetchJson(SEARCH_URL, { body: ibmListBody(scope, offset), provider: "ibm" });
        const parsed = parseOrThrow(IbmListSchema, raw, { provider: "ibm", slug: company.slug });
        return { items: parsed.hits.hits, total: parsed.hits.total.value };
      },
    });
    return hits.map((h) => normalize(company, h));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(SEARCH_URL, { body: ibmDetailBody(Number(posting.externalId)), provider: "ibm" });
    const parsed = parseOrNull(IbmDetailSchema, raw, { provider: "ibm", slug: company.slug });
    const body = parsed?.hits.hits[0]?._source.body;
    if (body === undefined) {
      logger.warn({ slug: company.slug, jobId: posting.externalId }, "ibm detail returned no body");
      return "";
    }
    return collapseWs(body);
  },
};

function normalize(company: AdapterCompany, h: IbmHit): NormalizedPosting {
  const s = h._source;
  return {
    provider: "ibm",
    externalId: String(s.field_text_01),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: s.title,
    jobUrl: s.url,
    location: ibmLocation(s.field_keyword_19 ?? "", s.field_keyword_05 ?? ""),
    isRemote: s.field_keyword_17 === "Remote",
    jdText: "",
    postedAt: null,
  };
}
