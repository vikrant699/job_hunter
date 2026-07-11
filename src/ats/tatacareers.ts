// src/ats/tatacareers.ts — Tata Group shared careers board (www.tata.com).
//
// www.tata.com/careers/jobs/joblisting is ONE dynamic board that aggregates
// live openings across ~20 Tata operating companies (confirmed live: Air
// India, Jaguar Land Rover, Tata AIA Life, Tata Capital, Tata Communications,
// Tata Consultancy Services, Tata Electronics, Tata Elxsi, Tata Steel (+ UK/
// Netherlands), Tata Technologies Europe, Tata Unistore, Titan, Tejas
// Networks, Tata 1mg, Tata Consumer Products, Tata International, Tata
// Motors, Indian Hotels, Agratas, ...). `apiMeta.company` selects the tenant,
// so one adapter covers every one of them.
//
// Data channel: POST /bin/tata/jobPostingsFilterServlet? (form-urlencoded) ->
// { response: { totalJobPostingsCount, jobPostings: [{ jobId, jobTitle,
// companyName, location, shortDescription, publishedDate }] } }. No cookie/
// session warm-up needed — verified live with a bare Node `fetch` — but the
// WAF in front of it 403s requests missing a browser UA + Referer/Origin/
// X-Requested-With, so those are always sent.
//
// IMPORTANT source limitation (verified live, not an adapter shortcoming):
// the servlet REQUIRES a non-empty `searchTerm` — filtering by `companies`
// alone with no search term returns "Invalid input parameters/values". There
// is no browse-all mode. We send a broad OR'd list of common job-title words
// to approximate "everything", but the server also hard-caps
// `totalJobPostingsCount` at 100 regardless of how broad the term list is
// (confirmed with two very different term-list sizes on the same tenant,
// both capped at exactly 100) — so a tenant with >100 live openings (e.g.
// Tata Consultancy Services) will only ever surface its top-100
// relevance-ranked matches, not a true total. Tenants with <=100 openings
// (most non-TCS-scale Tata companies) get complete coverage.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsHttpError } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { config } from "../config.js";

const HOST = "https://www.tata.com";
const SEARCH_URL = `${HOST}/bin/tata/jobPostingsFilterServlet?`;
const REFERER = `${HOST}/careers/jobs/joblisting`;
const DETAIL_PATH = `${HOST}/careers/jobs/jobdetails`;

const PAGE = 10; // server-fixed page size
/** Server-enforced ceiling on totalJobPostingsCount — see file header. */
const MAX_RESULTS = 100;

/**
 * Broad OR-matched vocabulary so one query approximates "every open role"
 * for a tenant. The servlet does a fuzzy/full-text match (not a strict title
 * substring — verified live: "Python" surfaced postings whose titles didn't
 * contain the word), so a wide net of common role words is the closest thing
 * to a wildcard this endpoint supports.
 */
export const BROAD_SEARCH_TERMS = [
  "Engineer", "Developer", "Manager", "Analyst", "Executive", "Associate",
  "Consultant", "Specialist", "Lead", "Officer", "Director", "Coordinator",
  "Administrator", "Designer", "Architect", "Technician", "Scientist",
  "Advisor", "Assistant", "Supervisor", "Representative", "Trainee",
  "Intern", "Sales", "Marketing", "Finance", "Operations", "Quality",
  "Support", "Product", "Data", "Cloud", "Security", "Network", "Research",
];

export const TataJobSchema = z.object({
  jobId: z.union([z.string(), z.number()]),
  jobTitle: z.string(),
  companyName: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  publishedDate: z.string().nullable().optional(),
});
export type TataJob = z.infer<typeof TataJobSchema>;

const TataResponseSchema = z.object({
  response: z.object({
    totalJobPostingsCount: z.number().nullable().optional(),
    jobPostings: z.array(TataJobSchema).nullable().optional(),
  }),
});

/** The exact company string the servlet expects, e.g. "Tata Elxsi". Required. */
export function tataCompanyName(company: AdapterCompany): string {
  const name = company.apiMeta?.company;
  if (!name) throw new Error(`tatacareers requires apiMeta.company for ${company.slug}`);
  return name;
}

/** Build the form-urlencoded body for one page of the shared search. `start` is 1-indexed. */
export function tataSearchParams(company: AdapterCompany, start: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set("searchTerm", BROAD_SEARCH_TERMS.join(", "));
  params.set("companies", JSON.stringify([tataCompanyName(company)]));
  params.set("searchMode", "search");
  params.set("start", String(start));
  if (start > 1) params.set("filtersFlag", "False");
  return params;
}

/** Unwrap+validate one page of the servlet's response envelope. */
export function parseTataPage(json: unknown): { jobs: TataJob[]; total: number | null } {
  const parsed = TataResponseSchema.parse(json);
  return {
    jobs: parsed.response.jobPostings ?? [],
    total: parsed.response.totalJobPostingsCount ?? null,
  };
}

/** Job detail page URL, matching the site's own link construction exactly. */
export function tataJobDetailUrl(company: AdapterCompany, j: TataJob): string {
  const params = new URLSearchParams({
    jobId: String(j.jobId),
    company: tataCompanyName(company),
    jobTitle: j.jobTitle,
    location: j.location ?? "",
  });
  return `${DETAIL_PATH}?${params.toString()}`;
}

export function normalizeTataCareers(company: AdapterCompany, j: TataJob): NormalizedPosting {
  const location = j.location ?? null;
  const isFlexible = location ? /^flexible\b/i.test(location.trim()) : false;
  const postedMs = j.publishedDate ? Date.parse(j.publishedDate) : Number.NaN;
  return {
    provider: "tatacareers",
    externalId: String(j.jobId),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle,
    jobUrl: tataJobDetailUrl(company, j),
    location,
    isRemote: isFlexible || (location ? REMOTE_RE.test(location) : false),
    jdText: htmlToText(j.shortDescription ?? ""),
    postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
  };
}

/** POST one page to the shared servlet. No cookie/session warm-up is needed
 *  (verified live) but the WAF 403s without a browser UA + these headers. */
async function tataFetchPage(company: AdapterCompany, start: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch.timeoutMs);
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": BROWSER_UA,
        Referer: REFERER,
        Origin: HOST,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: tataSearchParams(company, start).toString(),
      signal: controller.signal,
    });
    if (!res.ok) throw atsHttpError("tatacareers", res.status, await res.text());
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const tatacareersAdapter: AtsAdapter = {
  provider: "tatacareers",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "tatacareers",
      company: company.slug,
      pageSize: PAGE,
      maxPages: MAX_RESULTS / PAGE,
      fetchPage: async (offset) => {
        const raw = await tataFetchPage(company, offset + 1);
        let parsed: ReturnType<typeof parseTataPage>;
        try {
          parsed = parseTataPage(raw);
        } catch (err) {
          logger.warn({ slug: company.slug, err: String(err).slice(0, 200) }, "tatacareers list schema mismatch");
          throw new Error(`tatacareers list failed schema for ${company.slug}`);
        }
        return {
          items: parsed.jobs.map((j) => normalizeTataCareers(company, j)),
          total: parsed.total,
          rawCount: parsed.jobs.length,
        };
      },
    });
  },
  // shortDescription is the entirety of the JD shown even on the job detail
  // page (verified live) — there is no fuller version to fetch separately.
};
