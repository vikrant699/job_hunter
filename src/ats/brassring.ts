// src/ats/brassring.ts — IBM/Infinite BrassRing (Kenexa) "TGnewUI" boards on
// the shared host sjobs.brassring.com, keyed by partnerId + siteId.
//
//   list: POST https://sjobs.brassring.com/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs
//         body  {"partnerId":"<pid>","siteId":"<sid>","pageNumber":"<N>"}  (N 1-based)
//         header Content-Type: application/json (nothing else — the endpoint is
//         stateless; no cookie/CSRF/token needed)
//         -> { JobsCount, Jobs:{ Job:[ { Link, IsActive,
//                Questions:[{QuestionName,Value}] } ] } }
//         Page size is server-fixed at 50; walk pages until JobsCount is reached
//         or a page comes back empty. The scalar fields live in the Questions
//         array, which we flatten into a map. The full JD HTML is INLINE (in a
//         tenant-configured formtext column), so there is no per-job fetch.
//
// Field columns are TENANT-template-specific: `reqid`, `jobtitle`,
// `lastupdated`, `department` are stable BrassRing names, but the JD / city /
// country live in `formtextN` columns that vary per site. They default to
// ADM's (formtext3 / formtext8 / formtext10) and are overridable via apiMeta
// (jdField / cityField / countryField). partnerId + siteId are required apiMeta.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { decodeAttrEntities, htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const ENDPOINT = "https://sjobs.brassring.com/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs";
const PAGE = 50; // server-fixed

export interface BrassringConfig {
  partnerId: string;
  siteId: string;
  cityField: string;
  countryField: string;
  jdField: string;
}

/** Required partnerId/siteId + the tenant's column mapping (ADM defaults). */
export function brassringConfig(company: AdapterCompany): BrassringConfig {
  const partnerId = company.apiMeta?.partnerId;
  const siteId = company.apiMeta?.siteId;
  if (partnerId === undefined || partnerId === "") throw new Error(`brassring requires apiMeta.partnerId for ${company.slug}`);
  if (siteId === undefined || siteId === "") throw new Error(`brassring requires apiMeta.siteId for ${company.slug}`);
  return {
    partnerId,
    siteId,
    cityField: company.apiMeta?.cityField ?? "formtext8",
    countryField: company.apiMeta?.countryField ?? "formtext10",
    jdField: company.apiMeta?.jdField ?? "formtext3",
  };
}

/** The POST body for a 1-based page. */
export function brassringSearchBody(cfg: BrassringConfig, pageNumber: number): JsonValue {
  return { partnerId: cfg.partnerId, siteId: cfg.siteId, pageNumber: String(pageNumber) };
}

const BrassringQuestionSchema = z.object({
  QuestionName: z.string(),
  Value: z.string().nullable().optional(),
});
const BrassringJobSchema = z.object({
  Link: z.string().nullable().optional(),
  IsActive: z.boolean().nullable().optional(),
  Questions: z.array(BrassringQuestionSchema).nullable().optional(),
});
const BrassringPageSchema = z.object({
  JobsCount: z.number().nullable().optional(),
  Jobs: z.object({ Job: z.array(BrassringJobSchema).nullable().optional() }).nullable().optional(),
});

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
} as const;

/** Parse BrassRing's "13-Aug-2026" to a UTC-midnight ISO (timezone-stable),
 *  falling back to dateToIso for any other shape. */
export function brassringDate(s: string | null | undefined): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((s ?? "").trim());
  if (!m) return dateToIso(s);
  const month = MONTHS[(m[2] ?? "").toLowerCase()];
  if (month === undefined) return dateToIso(s);
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString();
}

function flatten(questions: z.infer<typeof BrassringJobSchema>["Questions"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const q of questions ?? []) {
    if (q.Value !== null && q.Value !== undefined) map.set(q.QuestionName, q.Value);
  }
  return map;
}

/** Parse one page into postings + the JobsCount total. */
export function parseBrassringPage(
  raw: JsonValue,
  company: AdapterCompany,
): { jobs: NormalizedPosting[]; total: number | null } {
  const cfg = brassringConfig(company);
  const page = parseOrThrow(BrassringPageSchema, raw, { provider: "brassring", slug: company.slug });
  const rows = page.Jobs?.Job ?? [];
  const jobs: NormalizedPosting[] = [];
  for (const row of rows) {
    const q = flatten(row.Questions);
    const externalId = q.get("reqid");
    if (externalId === undefined || externalId === "") continue; // no stable id
    const title = decodeAttrEntities(q.get("jobtitle") ?? "");
    const city = q.get(cfg.cityField);
    const country = q.get(cfg.countryField);
    const location = [city, country].filter((s): s is string => typeof s === "string" && s !== "").join(", ") || null;
    jobs.push({
      provider: "brassring",
      externalId,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle: title,
      jobUrl: row.Link ?? company.careersUrl,
      location,
      isRemote: REMOTE_RE.test(`${location ?? ""} ${title}`),
      jdText: htmlToText(q.get(cfg.jdField) ?? ""),
      postedAt: brassringDate(q.get("lastupdated")),
    });
  }
  return { jobs, total: page.JobsCount ?? null };
}

export const brassringAdapter: AtsAdapter = {
  provider: "brassring",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const cfg = brassringConfig(company);
    return paginate<NormalizedPosting>({
      provider: "brassring",
      company: company.slug,
      pageSize: PAGE,
      // Pages can carry fewer than 50 without being the last page's signal we
      // trust; terminate on the JobsCount total or an empty page instead.
      shortPageEndsPagination: false,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(ENDPOINT, {
          method: "POST",
          body: brassringSearchBody(cfg, page + 1),
          provider: "brassring",
        });
        const { jobs, total } = parseBrassringPage(raw, company);
        return { items: jobs, total };
      },
      dedupeBy: (p) => p.externalId,
    });
  },
};
