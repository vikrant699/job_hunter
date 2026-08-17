// src/ats/sfunify.ts — SAP SuccessFactors CSB "Unify" skin (e.g. careers.wipro.com, careers.hcltech.com, jobs.standardchartered.com, careers.skyworksinc.com).
// List: POST <origin>/services/recruiting/v1/jobs (page size server-fixed at 10). Detail: GET <origin>/job/<urlTitle>/<id>-<locale>, SSR HTML with the JD in one or more <span itemprop="description"> blocks.
// KNOWN LIMITATION: pageNumber-based pagination isn't fully deterministic - the same page can return a different 10-item slice on repeat requests (looks like backend replicas with different orderings), so a single crawl can undercount unique postings by ~10-20%. We dedupe by externalId and retry an all-duplicate page once; missed postings are expected to surface in a later scheduled crawl.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const PAGE = 10;

export const SfunifyJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  unifiedStandardTitle: z.string(),
  urlTitle: z.string().nullable().optional(),
  unifiedUrlTitle: z.string().nullable().optional(),
  // Present on Skyworks/Wipro/Standard Chartered as one pre-joined "City, State, Country" string.
  jobLocationShort: z.array(z.string()).nullable().optional(),
  // HCLTech has no jobLocationShort - carries city + country in separate custom fields instead.
  custprimecity: z.string().nullable().optional(),
  custCountryRegion: z.array(z.string()).nullable().optional(),
  unifiedStandardStart: z.string().nullable().optional(),
});
export type SfunifyJob = z.infer<typeof SfunifyJobSchema>;

const SfunifyListSchema = z.object({
  jobSearchResult: z.array(z.object({ response: SfunifyJobSchema })).nullable().optional(),
  totalJobs: z.number().nullable().optional(),
});

// Body for one page; locale defaults en_US (Standard Chartered needs en_GB via apiMeta.locale). The flat `location` field narrows by country on most tenants, but HCLTech ignores it entirely (0 results for any value) and instead needs the country facet routed through `facetFilters` via apiMeta.locationFacetField.
export function sfunifyRequestBody(company: AdapterCompany, pageNumber: number): Record<string, JsonValue> {
  const location = company.apiMeta?.location;
  const facetField = company.apiMeta?.locationFacetField;
  return {
    locale: company.apiMeta?.locale ?? "en_US",
    pageNumber,
    sortBy: "",
    keywords: "",
    location: facetField ? "" : (location ?? ""),
    facetFilters: facetField && location ? { [facetField]: [location] } : {},
    brand: "",
    skills: [],
    categoryId: 0,
    alertId: "",
    rcmCandidateId: "",
  };
}

/** Parse a list-page response body into its raw job entries + totalJobs. */
export function sfunifyPageJobs(pageJson: JsonValue): { jobs: SfunifyJob[]; totalJobs: number | null } {
  const parsed = SfunifyListSchema.parse(pageJson);
  return { jobs: (parsed.jobSearchResult ?? []).map((j) => j.response), totalJobs: parsed.totalJobs ?? null };
}

/** "M/D/YY" (2-digit year, en_US tenants) or "DD/MM/YYYY" (4-digit year, Standard Chartered's en_GB) -> ISO; which layout applies is inferred from the year digit count, not the request locale. Null otherwise. */
export function parseSfunifyStartDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, a, b, y] = m;
  if (a === undefined || b === undefined || y === undefined) return null;
  const fourDigitYear = y.length === 4;
  const year = fourDigitYear ? Number(y) : 2000 + Number(y);
  const [month, day] = fourDigitYear ? [Number(b), Number(a)] : [Number(a), Number(b)];
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `urlTitle`/`unifiedUrlTitle` arrive already percent-encoded from the API - interpolate as-is; re-encoding would double-encode the existing "%" escapes and 404. */
export function sfunifyJobUrl(company: AdapterCompany, job: SfunifyJob, locale: string): string {
  const slug = job.urlTitle ?? job.unifiedUrlTitle ?? "";
  return `${tenantOrigin(company)}/job/${slug}/${job.id}-${locale}`;
}

/** Prefers the pre-joined `jobLocationShort`, falling back to joining HCLTech's separate custom fields; some tenants (Wipro) embed a stray "<br/>" in jobLocationShort, so HTML is stripped either way. */
export function sfunifyLocation(job: SfunifyJob): string | null {
  const short = job.jobLocationShort?.[0];
  if (short) {
    const cleaned = short.replace(/<[^>]+>/g, "").trim();
    return cleaned || null;
  }
  const parts = [job.custprimecity, job.custCountryRegion?.[0]].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

export function normalizeSfunify(company: AdapterCompany, job: SfunifyJob, locale: string): NormalizedPosting {
  const location = sfunifyLocation(job);
  return {
    provider: "sfunify",
    externalId: job.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: job.unifiedStandardTitle,
    jobUrl: sfunifyJobUrl(company, job, locale),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: parseSfunifyStartDate(job.unifiedStandardStart),
  };
}

/** Joins every itemprop="description" span's text (the JD is rendered as 1-3 such spans); tracks span open/close depth rather than a naive match to the next </span>, since some tenants (Standard Chartered) nest inline <span style> runs that would otherwise truncate the JD. */
export function extractSfunifyJd(html: string): string {
  const blocks: string[] = [];
  const openRe = /<span\b[^>]*itemprop="description"[^>]*>/gi;
  const tagRe = /<span\b[^>]*>|<\/span>/gi;
  let om: RegExpExecArray | null;
  while ((om = openRe.exec(html)) !== null) {
    const start = om.index + om[0].length;
    let depth = 1;
    let end = html.length;
    tagRe.lastIndex = start;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(html)) !== null) {
      if (tm[0].toLowerCase() === "</span>") {
        depth--;
        if (depth === 0) {
          end = tm.index;
          break;
        }
      } else {
        depth++;
      }
    }
    blocks.push(html.slice(start, end));
    openRe.lastIndex = end;
  }
  return htmlToText(blocks.join("\n\n"));
}

export const sfunifyAdapter: AtsAdapter = {
  provider: "sfunify",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const locale = company.apiMeta?.locale ?? "en_US";
    const url = `${tenantOrigin(company)}/services/recruiting/v1/jobs`;
    const seen = new Set<string>();

    const fetchOnce = async (page: number) => {
      const raw = await atsFetchJson(url, {
        method: "POST",
        body: sfunifyRequestBody(company, page),
        provider: "sfunify",
      });
      return sfunifyPageJobs(raw);
    };

    return paginate<NormalizedPosting>({
      provider: "sfunify",
      company: company.slug,
      pageSize: PAGE,
      // Page slicing isn't reliably tied to pageSize (see module header) - only an empty page or reaching totalJobs ends pagination.
      shortPageEndsPagination: false,
      // dedupeBy handles cross-page accumulation; `seen` is tracked separately only so fetchPage can know BEFORE filtering whether a page was 100% already-collected, to decide the retry below.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        let { jobs, totalJobs } = await fetchOnce(page);
        const allDuplicate = jobs.length > 0 && jobs.every((j) => seen.has(j.id));
        // Retry once on an all-duplicate page - resampling the same pageNumber sometimes surfaces a different backend replica's ordering.
        if (allDuplicate && (totalJobs === null || seen.size < totalJobs)) {
          ({ jobs, totalJobs } = await fetchOnce(page));
        }
        for (const j of jobs) seen.add(j.id);
        return {
          items: jobs.map((j) => normalizeSfunify(company, j, locale)),
          total: totalJobs,
          rawCount: jobs.length,
        };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "sfunify" });
    return extractSfunifyJd(html);
  },
};
