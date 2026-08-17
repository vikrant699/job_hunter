// src/ats/amazonjobs.ts — Amazon's public jobs search API (www.amazon.jobs).
// GET /en/search.json?country=<cc>&result_limit=N&offset=M&sort=recent; full JD inline; result_limit caps at 100.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";

const BASE = "https://www.amazon.jobs";
const RESULT_LIMIT = 100; // server max for result_limit
const MAX_PAGES = 5000; // runaway backstop only, never truncate

export const AmazonJobSchema = z.object({
  id_icims: z.string(),
  title: z.string(),
  location: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  job_path: z.string(),
  posted_date: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  description_short: z.string().nullable().optional(),
  // Qualifications are separate fields, not part of description - needed for the YOE gate.
  basic_qualifications: z.string().nullable().optional(),
  preferred_qualifications: z.string().nullable().optional(),
});
export type AmazonJob = z.infer<typeof AmazonJobSchema>;

const AmazonJobsPageSchema = z.object({
  hits: z.number().nullable().optional(),
  jobs: z.array(AmazonJobSchema),
});

/** Paged search URL; `apiMeta.country` (e.g. "IND") narrows the board, defaults to India. */
export function amazonJobsApiUrl(company: AdapterCompany, offset: number): string {
  const country = company.apiMeta?.country ?? "IND";
  return `${BASE}/en/search.json?country=${encodeURIComponent(country)}&result_limit=${RESULT_LIMIT}&offset=${offset}&sort=recent`;
}

export function amazonJobsPageJobs(pageJson: JsonValue): { jobs: AmazonJob[]; total: number | null } {
  const parsed = AmazonJobsPageSchema.parse(pageJson);
  return { jobs: parsed.jobs, total: parsed.hits ?? null };
}

/** Assemble the full JD from description + labelled qualifications sections. */
export function amazonJdText(j: AmazonJob): string {
  const sections: string[] = [htmlToText(j.description ?? j.description_short ?? "")];
  const basic = htmlToText(j.basic_qualifications ?? "");
  if (basic !== "") sections.push(`Basic qualifications:\n${basic}`);
  const preferred = htmlToText(j.preferred_qualifications ?? "");
  if (preferred !== "") sections.push(`Preferred qualifications:\n${preferred}`);
  return sections.filter((s) => s.trim() !== "").join("\n\n");
}

export function normalizeAmazonJobs(company: AdapterCompany, j: AmazonJob): NormalizedPosting {
  const cityCountry = [j.city, j.country_code]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(", ");
  const location = j.location ?? (cityCountry.length > 0 ? cityCountry : null);
  return {
    provider: "amazonjobs",
    externalId: j.id_icims,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `${BASE}${j.job_path}`,
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: amazonJdText(j),
    postedAt: dateToIso(j.posted_date),
  };
}

export const amazonJobsAdapter: AtsAdapter = {
  provider: "amazonjobs",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "amazonjobs",
      company: company.slug,
      pageSize: RESULT_LIMIT,
      maxPages: MAX_PAGES,
      fetchPage: async (offset) => {
        const json = await atsFetchJson(amazonJobsApiUrl(company, offset), {
          provider: "amazonjobs",
          userAgent: BROWSER_UA,
        });
        const { jobs, total } = amazonJobsPageJobs(json);
        return {
          items: jobs.map((j) => normalizeAmazonJobs(company, j)),
          total,
        };
      },
    });
  },
  // The list response carries the full description — no fetchJd needed.
};
