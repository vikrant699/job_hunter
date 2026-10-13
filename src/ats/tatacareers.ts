// POST /bin/tata/jobPostingsFilterServlet? (form-urlencoded; browser UA + Referer/Origin/X-Requested-With required or the WAF 403s) -> { response: { totalJobPostingsCount, jobPostings } }; detail URL is built from the job's own fields.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchFormJson } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";

const HOST = "https://www.tata.com";
const SEARCH_URL = `${HOST}/bin/tata/jobPostingsFilterServlet?`;
const REFERER = `${HOST}/careers/jobs/joblisting`;
const DETAIL_PATH = `${HOST}/careers/jobs/jobdetails`;

const PAGE = 10;
// Server caps results at 100 relevance-ranked matches (no browse-all mode; searchTerm must be non-empty), so tenants with >100 roles (TCS) are truncated.
const MAX_RESULTS = 100;

// Fuzzy full-text OR-match: a wide net of common role words is the closest thing to a wildcard.
export const BROAD_SEARCH_TERMS = [
  "Engineer", "Developer", "Manager", "Analyst", "Executive", "Associate",
  "Consultant", "Specialist", "Lead", "Officer", "Director", "Coordinator",
  "Administrator", "Designer", "Architect", "Technician", "Scientist",
  "Advisor", "Assistant", "Supervisor", "Representative", "Trainee",
  "Intern", "Sales", "Marketing", "Finance", "Operations", "Quality",
  "Support", "Product", "Data", "Cloud", "Security", "Network", "Research",
  "Captain", "Pilot", "Apprentice", "Crew", "Job",
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

// Exact company string the servlet expects, e.g. "Tata Elxsi".
export function tataCompanyName(company: AdapterCompany): string {
  const name = company.apiMeta?.company;
  if (!name) throw new Error(`tatacareers requires apiMeta.company for ${company.slug}`);
  return name;
}

export function tataSearchParams(company: AdapterCompany, start: number): URLSearchParams {
  const params = new URLSearchParams();
  // The company name matches nearly every JD body, catching titles no role word covers.
  params.set("searchTerm", [...BROAD_SEARCH_TERMS, tataCompanyName(company)].join(", "));
  params.set("companies", JSON.stringify([tataCompanyName(company)]));
  params.set("searchMode", "search");
  params.set("start", String(start));
  if (start > 1) params.set("filtersFlag", "False");
  return params;
}

export function parseTataPage(json: JsonValue): { jobs: TataJob[]; total: number | null } {
  const parsed = TataResponseSchema.parse(json);
  return {
    jobs: parsed.response.jobPostings ?? [],
    total: parsed.response.totalJobPostingsCount ?? null,
  };
}

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
    postedAt: dateToIso(j.publishedDate),
  };
}

async function tataFetchPage(company: AdapterCompany, start: number): Promise<JsonValue> {
  const form = Object.fromEntries(tataSearchParams(company, start));
  return atsFetchFormJson(SEARCH_URL, form, {
    provider: "tatacareers",
    userAgent: BROWSER_UA,
    headers: {
      Referer: REFERER,
      Origin: HOST,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
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
  // shortDescription is the entire JD even on the detail page.
};
