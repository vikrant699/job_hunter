// src/ats/peoplestrong.ts — PeopleStrong (Altone) career portals. Each tenant is
// a subdomain: <tenant>.peoplestrong.com. The board is a JS app backed by a
// clean, unauthenticated JSON API sharing one path across every tenant:
//
//   list: POST https://<tenant>.peoplestrong.com/api/cp/rest/altone/cp/jobs/v1?offset=0&limit=45
//         body {} -> { totalRecords, response: [ { jobTitle, jobCode,
//                        locationHierarchy, jobDetailUrl, jobPostedDate, ... } ] }
//         Paginate offset += 45 until totalRecords collected.
//
//   jd:   GET https://<tenant>.peoplestrong.com/api/cp/rest/altone/cp/job/
//              <jobCode with "/" -> "_">/v2?part=basic,organisational,descriprion,...&isReqId=false
//         -> { response: { jobDescription: "<html>", ... } }  (vendor misspells
//            "descriprion" in the part list — that spelling is required).
//
// externalId is jobCode (stable, also the JD key). jobDetailUrl is populated on
// some tenants and null on others (e.g. RBL); when absent we construct the same
// public deep link the populated tenants use: /job/detail/<jobCode _-encoded>.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const PAGE = 45; // vendor-fixed page size
// Safety cap: 225,000 jobs (PAGE 45 x MAX_PAGES 5000). Largest known tenant
// (Larsen & Toubro) is ~1311 jobs -> ~30 pages, so this is generous headroom,
// not a real ceiling. listPostings logs if hit.
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

export const PeoplestrongJobSchema = z.object({
  jobCode: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  locationHierarchy: z.string().nullable().optional(),
  locationHierarchyComplete: z.string().nullable().optional(),
  jobDetailUrl: z.string().nullable().optional(),
  jobPostedDate: z.string().nullable().optional(),
});
export type PeoplestrongJob = z.infer<typeof PeoplestrongJobSchema>;

export const PeoplestrongListSchema = z.object({
  totalRecords: z.number().nullable().optional(),
  response: z.array(PeoplestrongJobSchema),
});

export const PeoplestrongJdSchema = z.object({
  response: z
    .object({ jobDescription: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

/** Origin (https://<tenant>.peoplestrong.com) from the tenant/careers URL. */
export function peoplestrongBase(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/** Paged list endpoint at the given 0-based offset. */
export function peoplestrongListUrl(base: string, offset: number, limit = PAGE): string {
  return `${base}/api/cp/rest/altone/cp/jobs/v1?offset=${offset}&limit=${limit}`;
}

/** JD endpoint for a jobCode. The path segment replaces every "/" with "_". */
export function peoplestrongJdUrl(base: string, jobCode: string): string {
  const encoded = jobCode.replace(/\//g, "_");
  return (
    `${base}/api/cp/rest/altone/cp/job/${encoded}/v2` +
    `?part=basic,organisational,descriprion,workflow,skill,qualification,certification,language,applied` +
    `&isReqId=false`
  );
}

/** Public deep link for a posting: the API's jobDetailUrl when it gives one,
 *  else the same /job/detail/<jobCode _-encoded> link the other tenants use. */
export function peoplestrongJobUrl(base: string, j: PeoplestrongJob): string {
  if (j.jobDetailUrl && /^https?:\/\//i.test(j.jobDetailUrl)) return j.jobDetailUrl;
  if (j.jobCode) return `${base}/job/detail/${j.jobCode.replace(/\//g, "_")}`;
  return base;
}

/** Date-only strings ("2026-07-08"). Null-safe; returns null on unparseable. */
function parsePeoplestrongDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Map one API job to a NormalizedPosting. Null when the job has no jobCode
 *  (no stable id / JD key), so the caller can skip it. */
export function normalizePeoplestrong(
  company: AdapterCompany,
  j: PeoplestrongJob,
): NormalizedPosting | null {
  if (!j.jobCode) return null;
  const location = j.locationHierarchy ?? j.locationHierarchyComplete ?? null;
  return {
    provider: "peoplestrong",
    externalId: j.jobCode,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle ?? "",
    jobUrl: peoplestrongJobUrl(peoplestrongBase(company), j),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: parsePeoplestrongDate(j.jobPostedDate),
  };
}

/** Extract the JD body HTML from a job-detail response and strip to plain text. */
export function parsePeoplestrongJd(raw: unknown): string {
  const parsed = PeoplestrongJdSchema.safeParse(raw);
  if (!parsed.success) return "";
  return htmlToText(parsed.data.response?.jobDescription ?? "");
}

export const peoplestrongAdapter: AtsAdapter = {
  provider: "peoplestrong",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = peoplestrongBase(company);
    // Boxed in an object: a bare `let total` mutated only inside the fetchPage
    // closure defeats TS's narrowing (it can't see paginate() invoking the
    // closure, so it treats `total` as permanently its initial `null`); a
    // property write is narrowed correctly at each read below.
    const state: { total: number | null } = { total: null };

    const postings = await paginate<NormalizedPosting>({
      provider: "peoplestrong",
      company: company.slug,
      pageSize: PAGE,
      maxPages: MAX_PAGES,
      fetchPage: async (offset) => {
        const raw = await atsFetchJson(peoplestrongListUrl(base, offset), {
          method: "POST",
          body: {},
          provider: "peoplestrong",
        });
        const parsed = parseOrThrow(PeoplestrongListSchema, raw, {
          provider: "peoplestrong",
          slug: company.slug,
          what: `list (offset ${offset})`,
        });
        if (state.total === null && typeof parsed.totalRecords === "number") {
          state.total = parsed.totalRecords;
        }
        const items = parsed.response
          .map((j) => normalizePeoplestrong(company, j))
          .filter((p): p is NormalizedPosting => p !== null);
        // Advance by the raw record count, not the filtered count, so jobs
        // dropped for a missing jobCode don't shorten the page and stop early.
        return { items, total: parsed.totalRecords ?? null, rawCount: parsed.response.length };
      },
    });

    const total = state.total;
    if (total !== null && Math.ceil(total / PAGE) > MAX_PAGES) {
      logger.warn(
        { slug: company.slug, collected: postings.length, total, maxPages: MAX_PAGES },
        "peoplestrong pagination capped — board larger than the safety limit",
      );
    } else if (total !== null && postings.length < total) {
      logger.info(
        { slug: company.slug, collected: postings.length, total },
        "peoplestrong collected fewer postings than totalRecords — some jobs had no jobCode",
      );
    }

    return postings;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const base = peoplestrongBase(company);
    const raw = await atsFetchJson(peoplestrongJdUrl(base, posting.externalId), {
      provider: "peoplestrong",
    });
    return parsePeoplestrongJd(raw);
  },
};
