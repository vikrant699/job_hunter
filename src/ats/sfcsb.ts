// src/ats/sfcsb.ts — SAP SuccessFactors "CSB" (Career Site Builder / SAPUI5)
// recruiting JSON API. DISTINCT from src/ats/successfactors.ts, which scrapes
// the legacy jobs2web/RMK server-rendered HTML board. CSB tenants serve a clean
// JSON list but render the job page as SSR HTML (JD in an itemprop span).
//
//   list: POST <host>/services/recruiting/v1/jobs
//         header Content-Type: application/json (nothing else)
//         body   {"keywords":"","locale":"en_US","pageNumber":<N>}  (N 1-based)
//         -> { totalJobs, jobSearchResult:[{ response:{ id, unifiedStandardTitle,
//              urlTitle, unifiedStandardStart, + location(tenant-shaped) } }] }
//         Page size is server-fixed at 10 (offset/limit are ignored); walk pages
//         until totalJobs is reached or a page returns no results. There is no
//         server-side country facet, so the pipeline's location filter does the
//         India cut. Location is tenant-shaped: `jobLocationShort[]` (an array of
//         "Country, State, City" strings) OR `custprimecity` + `custCountryRegion[]`.
//   JD:   GET <host>/job/<slug>/<id>-en_US/   (slug cosmetic; "x" works)
//         -> SSR HTML; the JD lives in the richest <span itemprop="description">
//         (there are several — a meta and empty placeholders — so take the longest).
import { z } from "zod";
import * as cheerio from "cheerio";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const PAGE = 10; // server-fixed
const LOCALE = "en_US";

const MONTHS_MDY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;

/** Parse the CSB "M/D/YY" start date to a UTC-midnight ISO (timezone-stable). */
export function sfcsbDate(s: string | null | undefined): string | null {
  const m = MONTHS_MDY_RE.exec((s ?? "").trim());
  if (!m) return null;
  const year = 2000 + Number(m[3]);
  return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2]))).toISOString();
}

const SfcsbJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  unifiedStandardTitle: z.string(),
  urlTitle: z.string().nullable().optional(),
  unifiedStandardStart: z.string().nullable().optional(),
  jobLocationShort: z.array(z.string()).nullable().optional(),
  custprimecity: z.string().nullable().optional(),
  custCountryRegion: z.array(z.string()).nullable().optional(),
});
const SfcsbResponseSchema = z.object({
  totalJobs: z.number().nullable().optional(),
  jobSearchResult: z.array(z.object({ response: SfcsbJobSchema })).nullable().optional(),
});

/** The POST body for a 1-based page. Locale defaults to en_US but is a
 *  TENANT setting: indegene's board returns totalJobs=4 under en_US and 73
 *  under en_GB (verified live 2026-08-13) — apiMeta.locale overrides. */
export function sfcsbSearchBody(pageNumber: number, locale: string = LOCALE): JsonValue {
  return { keywords: "", locale, pageNumber };
}

/** Canonical public job URL; the slug segment is cosmetic. */
export function sfcsbJobUrl(company: AdapterCompany, id: string, slug: string | null | undefined): string {
  const seg = slug !== undefined && slug !== null && slug !== "" ? slug : "x";
  const locale = company.apiMeta?.locale ?? LOCALE;
  return `${tenantOrigin(company)}/job/${seg}/${id}-${locale}/`;
}

function sfcsbLocation(j: z.infer<typeof SfcsbJobSchema>): string | null {
  if (j.jobLocationShort && j.jobLocationShort.length > 0) {
    return j.jobLocationShort.map((s) => s.trim()).filter((s) => s !== "").join("; ") || null;
  }
  const parts = [j.custprimecity, j.custCountryRegion?.[0]].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Parse one page into postings + the totalJobs count (jdText filled by fetchJd). */
export function parseSfcsbPage(
  raw: JsonValue,
  company: AdapterCompany,
): { jobs: NormalizedPosting[]; total: number | null } {
  const page = parseOrThrow(SfcsbResponseSchema, raw, { provider: "sfcsb", slug: company.slug });
  const jobs = (page.jobSearchResult ?? []).map(({ response: j }) => {
    const location = sfcsbLocation(j);
    return {
      provider: "sfcsb" as const,
      externalId: j.id,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: j.unifiedStandardTitle,
      jobUrl: sfcsbJobUrl(company, j.id, j.urlTitle),
      location,
      isRemote: REMOTE_RE.test(`${location ?? ""} ${j.unifiedStandardTitle}`),
      jdText: "",
      postedAt: sfcsbDate(j.unifiedStandardStart),
    };
  });
  return { jobs, total: page.totalJobs ?? null };
}

/** Extract the JD from a CSB job page: the richest itemprop="description" span. */
export function parseSfcsbJd(html: string): string {
  const $ = cheerio.load(html);
  let best = "";
  $("span[itemprop=description]").each((_i, el) => {
    const text = htmlToText($(el).html() ?? "");
    if (text.length > best.length) best = text;
  });
  return best;
}

export const sfcsbAdapter: AtsAdapter = {
  provider: "sfcsb",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // CSB pagination is UNSTABLE: the default sort shifts between requests, so
    // the same job recurs across pages and a page can fully repeat an earlier
    // one (TUV SUD served 354 rows across 37 pages for ~280 unique jobs, and
    // reports an inflated totalJobs). We therefore do NOT hand `dedupeBy` to
    // paginate — its stall guard would break on the first byte-for-byte repeat
    // page and truncate the board. Instead we walk to the natural empty page
    // and dedupe the accumulated rows here.
    const raw = await paginate<NormalizedPosting>({
      provider: "sfcsb",
      company: company.slug,
      pageSize: PAGE,
      shortPageEndsPagination: false,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(`${tenantOrigin(company)}/services/recruiting/v1/jobs`, {
          method: "POST",
          body: sfcsbSearchBody(page + 1, company.apiMeta?.locale ?? undefined),
          provider: "sfcsb",
        });
        const { jobs, total } = parseSfcsbPage(json, company);
        return { items: jobs, total };
      },
    });
    const seen = new Set<string>();
    const out: NormalizedPosting[] = [];
    for (const p of raw) {
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }
    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "sfcsb" });
    const jd = parseSfcsbJd(html);
    if (jd === "") {
      logger.warn({ company: company.slug, job: posting.externalId }, "sfcsb: job page had no itemprop=description content");
    }
    return jd;
  },
};
