// src/ats/sfunify.ts — SAP SuccessFactors Career Site Builder "Unify" skin
// (e.g. careers.wipro.com, careers.hcltech.com, jobs.standardchartered.com,
// careers.skyworksinc.com).
//
// List: POST <origin>/services/recruiting/v1/jobs with a JSON body (see
// sfunifyRequestBody); response is
//   { jobSearchResult: [{ response: {...job fields} }], totalJobs }
// Page size is server-fixed at 10 — size/pageSize/resultsPerPage body fields
// are silently ignored.
//
// Detail: GET <origin>/job/<urlTitle>/<id>-<locale> — plain server-rendered
// HTML (no JS needed); the full JD text lives in one or more
// <span itemprop="description"> blocks.
//
// KNOWN LIMITATION (confirmed live on careers.skyworksinc.com, 2026-07-12):
// pageNumber-based pagination on this API is NOT fully deterministic — the
// same pageNumber sometimes returns a different 10-item slice across
// repeated identical requests (looks like a small pool of backend replicas
// with slightly different internal orderings; not fixed by resending the
// JSESSIONID sticky cookie the server sets). The *counts* per page reliably
// sum to `totalJobs`, but the *set* of unique postings collected in one
// crawl can fall short by ~10-20%. We dedupe by externalId and retry a page
// once when it comes back 100% duplicate, which recovers some of that for
// free, but full completeness in a single run isn't guaranteed. Postings
// missed in one run are expected to surface in a later scheduled crawl since
// (provider, external_id) upserts persist whatever's been seen so far.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const PAGE = 10;

export const SfunifyJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  unifiedStandardTitle: z.string(),
  urlTitle: z.string().nullable().optional(),
  unifiedUrlTitle: z.string().nullable().optional(),
  // Present on Skyworks/Wipro/Standard Chartered as one pre-joined "City,
  // State, Country" string.
  jobLocationShort: z.array(z.string()).nullable().optional(),
  // HCLTech's tenant has no jobLocationShort at all — its per-client-configured
  // custom fields carry city + country separately instead.
  custprimecity: z.string().nullable().optional(),
  custCountryRegion: z.array(z.string()).nullable().optional(),
  unifiedStandardStart: z.string().nullable().optional(),
});
export type SfunifyJob = z.infer<typeof SfunifyJobSchema>;

const SfunifyListSchema = z.object({
  jobSearchResult: z.array(z.object({ response: SfunifyJobSchema })).nullable().optional(),
  totalJobs: z.number().nullable().optional(),
});

function origin(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/**
 * Request body for one page. `locale` defaults to "en_US"; some tenants
 * (Standard Chartered) require "en_GB" instead — set via `apiMeta.locale`.
 *
 * `location` narrows the search server-side by country name (e.g. "India")
 * when `apiMeta.location` is set, via the flat `location` field — this works
 * on Skyworks/Wipro/Standard Chartered. HCLTech's tenant does NOT honor that
 * field (it returns 0 results for ANY non-empty value, confirmed live with
 * both a real and a nonsense country); it instead exposes the same country
 * facet under a custom field name (`custCountryRegion`) that must go through
 * `facetFilters`. Set `apiMeta.locationFacetField` to the facet's field name
 * (e.g. "custCountryRegion") to route the filter through `facetFilters`
 * instead of the flat field for such tenants.
 */
export function sfunifyRequestBody(company: AdapterCompany, pageNumber: number): Record<string, unknown> {
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
export function sfunifyPageJobs(pageJson: unknown): { jobs: SfunifyJob[]; totalJobs: number | null } {
  const parsed = SfunifyListSchema.parse(pageJson);
  return { jobs: (parsed.jobSearchResult ?? []).map((j) => j.response), totalJobs: parsed.totalJobs ?? null };
}

/**
 * "M/D/YY" (2-digit year — Skyworks/Wipro/HCLTech's en_US-style tenants) or
 * "DD/MM/YYYY" (4-digit year — Standard Chartered's en_GB) → ISO. Which
 * layout applies is inferred from the year segment's digit count rather
 * than the request locale, since that's what actually distinguishes the two
 * formats observed live. Returns null for anything else.
 */
export function parseSfunifyStartDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const a = m[1]!;
  const b = m[2]!;
  const y = m[3]!;
  const fourDigitYear = y.length === 4;
  const year = fourDigitYear ? Number(y) : 2000 + Number(y);
  const [month, day] = fourDigitYear ? [Number(b), Number(a)] : [Number(a), Number(b)];
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Job detail URL. `urlTitle` (falling back to `unifiedUrlTitle`) arrives
 * already percent-encoded from the API (e.g.
 * "Sr_-Buyer-2%E3%80%80%28Strategic-Sourcing-Specialist%29") — interpolate
 * it as-is; running it through encodeURIComponent again would double-encode
 * the existing "%" escapes and 404.
 */
export function sfunifyJobUrl(company: AdapterCompany, job: SfunifyJob, locale: string): string {
  const slug = job.urlTitle ?? job.unifiedUrlTitle ?? "";
  return `${origin(company)}/job/${slug}/${job.id}-${locale}`;
}

/**
 * Location string for a job entry. Prefers the pre-joined `jobLocationShort`
 * (Skyworks/Wipro/Standard Chartered); falls back to joining HCLTech's
 * separate `custprimecity` + `custCountryRegion` custom fields when that's
 * absent. Some tenants (Wipro) embed a stray literal "<br/>" in
 * jobLocationShort (e.g. "Tampa, USA-FL, USA, 33634<br/>") — strip any HTML
 * before use either way.
 */
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

/**
 * Extract every `<span itemprop="description">...</span>` block's text and
 * join them — the job detail page renders the JD server-side as 1-3 such
 * spans (intro company boilerplate, the actual "Job Description:" section,
 * and sometimes a closing EEO statement). Some tenants (Standard Chartered)
 * nest plain `<span style="...">` runs inside for inline font styling, so a
 * naive non-greedy match against the next `</span>` truncates the JD at that
 * inner tag — this walks span open/close tags counting depth to find the
 * outer span's real matching close instead.
 */
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
    const url = `${origin(company)}/services/recruiting/v1/jobs`;
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
      // The server's own page slicing isn't reliably tied to `pageSize` —
      // see the module-level comment. Only a genuinely empty page or
      // reaching `totalJobs` ends pagination.
      shortPageEndsPagination: false,
      fetchPage: async (_offset, page) => {
        let { jobs, totalJobs } = await fetchOnce(page);
        let fresh = jobs.filter((j) => !seen.has(j.id));
        // A page that comes back 100% duplicate doesn't necessarily mean
        // we're done — retry once, since resampling the same pageNumber
        // sometimes surfaces a different backend replica's ordering.
        if (jobs.length > 0 && fresh.length === 0 && (totalJobs === null || seen.size < totalJobs)) {
          ({ jobs, totalJobs } = await fetchOnce(page));
          fresh = jobs.filter((j) => !seen.has(j.id));
        }
        for (const j of fresh) seen.add(j.id);
        return {
          items: fresh.map((j) => normalizeSfunify(company, j, locale)),
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
