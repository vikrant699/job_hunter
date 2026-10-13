// List: POST <origin>/services/recruiting/v1/jobs (page size fixed at 10). Detail: GET <origin>/job/<urlTitle>/<id>-<locale>, JD in <span itemprop="description"> blocks.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchText } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin } from "./shared.js";
import type { JsonValue } from "../util/json.js";
import { logger } from "../logger.js";

const PAGE = 10;

export const SfunifyJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  unifiedStandardTitle: z.string(),
  urlTitle: z.string().nullable().optional(),
  unifiedUrlTitle: z.string().nullable().optional(),
  jobLocationShort: z.array(z.string()).nullable().optional(),
  custprimecity: z.string().nullable().optional(),
  custCountryRegion: z.array(z.string()).nullable().optional(),
  unifiedStandardStart: z.string().nullable().optional(),
});
export type SfunifyJob = z.infer<typeof SfunifyJobSchema>;

const SfunifyListSchema = z.object({
  jobSearchResult: z.array(z.object({ response: SfunifyJobSchema })).nullable().optional(),
  totalJobs: z.number().nullable().optional(),
});

// HCLTech ignores the flat `location` field (0 results), so its country facet goes through `facetFilters` via apiMeta.locationFacetField.
export function sfunifyRequestBody(
  company: AdapterCompany,
  pageNumber: number,
  locale: string = company.apiMeta?.locale ?? "en_US",
): Record<string, JsonValue> {
  const location = company.apiMeta?.location;
  const facetField = company.apiMeta?.locationFacetField;
  return {
    locale,
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

export function sfunifyDefaultLocale(html: string): string | null {
  const scripted = html.match(/defaultLocale\s*:\s*['"]([a-z]{2}_[A-Z]{2})['"]/)?.[1];
  if (scripted) return scripted;
  const lang = html.match(/<html\b[^>]*\slang="([a-z]{2})-([A-Z]{2})"/);
  return lang ? `${lang[1] ?? ""}_${lang[2] ?? ""}` : null;
}

// Some tenants answer {"totalJobs":0} for en_US and list only under their default locale, so ask the homepage first.
async function resolveSfunifyLocale(company: AdapterCompany): Promise<string> {
  const configured = company.apiMeta?.locale;
  if (configured) return configured;
  try {
    return sfunifyDefaultLocale(await atsFetchText(`${tenantOrigin(company)}/`, { provider: "sfunify" })) ?? "en_US";
  } catch (err) {
    logger.warn({ slug: company.slug, err: String(err).slice(0, 160) }, "sfunify homepage locale probe failed; using en_US");
    return "en_US";
  }
}

export function sfunifyPageJobs(pageJson: JsonValue): { jobs: SfunifyJob[]; totalJobs: number | null } {
  const parsed = SfunifyListSchema.parse(pageJson);
  return { jobs: (parsed.jobSearchResult ?? []).map((j) => j.response), totalJobs: parsed.totalJobs ?? null };
}

/** Layout inferred from the year digit count: "M/D/YY" (en_US) or "DD/MM/YYYY" (Standard Chartered en_GB). */
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

/** urlTitle arrives already percent-encoded; re-encoding would double-encode and 404. */
export function sfunifyJobUrl(company: AdapterCompany, job: SfunifyJob, locale: string): string {
  const slug = job.urlTitle ?? job.unifiedUrlTitle ?? "";
  return `${tenantOrigin(company)}/job/${slug}/${job.id}-${locale}`;
}

/** Some tenants (Wipro) embed a stray "<br/>" in jobLocationShort, so HTML is stripped either way. */
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

/** Track span depth, not the next </span>: some tenants (Standard Chartered) nest inline <span style> runs that would truncate the JD. */
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
    const locale = await resolveSfunifyLocale(company);
    const url = `${tenantOrigin(company)}/services/recruiting/v1/jobs`;
    const seen = new Set<string>();

    const fetchOnce = async (page: number) => {
      const raw = await atsFetchJson(url, {
        method: "POST",
        body: sfunifyRequestBody(company, page, locale),
        provider: "sfunify",
      });
      return sfunifyPageJobs(raw);
    };

    return paginate<NormalizedPosting>({
      provider: "sfunify",
      company: company.slug,
      pageSize: PAGE,
      // Pagination isn't deterministic (a repeated page can return a different 10-item slice), so only an empty page or reaching totalJobs ends it.
      shortPageEndsPagination: false,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (_offset, page) => {
        let { jobs, totalJobs } = await fetchOnce(page);
        const allDuplicate = jobs.length > 0 && jobs.every((j) => seen.has(j.id));
        // Retry once on an all-duplicate page: resampling can hit a different backend replica's ordering.
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
