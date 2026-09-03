// src/ats/peoplestrong.ts — PeopleStrong (Altone) career portals (<tenant>.peoplestrong.com): a clean unauthenticated JSON API, paginated offset+=45 on the list endpoint.
// The JD endpoint's `part=` list requires the vendor's misspelling "descriprion" verbatim.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const PAGE = 45; // vendor-fixed page size
// Safety cap only (PAGE 45 x MAX_PAGES 5000 = 225,000 jobs); largest known tenant is ~1311 jobs (~30 pages) — listPostings logs if this is ever hit.
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
  response: z.array(PeoplestrongJobSchema).nullable(), // an empty board serializes this as null, not []
});

export const PeoplestrongJdSchema = z.object({
  response: z
    .object({ jobDescription: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

export function peoplestrongListUrl(base: string, offset: number, limit = PAGE): string {
  return `${base}/api/cp/rest/altone/cp/jobs/v1?offset=${offset}&limit=${limit}`;
}

// The jobCode path segment replaces every "/" with "_".
export function peoplestrongJdUrl(base: string, jobCode: string): string {
  const encoded = jobCode.replace(/\//g, "_");
  return (
    `${base}/api/cp/rest/altone/cp/job/${encoded}/v2` +
    `?part=basic,organisational,descriprion,workflow,skill,qualification,certification,language,applied` +
    `&isReqId=false`
  );
}

export function peoplestrongJobUrl(base: string, j: PeoplestrongJob): string {
  if (j.jobDetailUrl && /^https?:\/\//i.test(j.jobDetailUrl)) return j.jobDetailUrl;
  if (j.jobCode) return `${base}/job/detail/${j.jobCode.replace(/\//g, "_")}`;
  return base;
}

// Null when the job has no jobCode (no stable id / JD key), so the caller can skip it.
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
    jobUrl: peoplestrongJobUrl(tenantOrigin(company), j),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: dateToIso(j.jobPostedDate),
  };
}

export function parsePeoplestrongJd(raw: JsonValue): string {
  const parsed = PeoplestrongJdSchema.safeParse(raw);
  if (!parsed.success) return "";
  return htmlToText(parsed.data.response?.jobDescription ?? "");
}

export const peoplestrongAdapter: AtsAdapter = {
  provider: "peoplestrong",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = tenantOrigin(company);
    // Boxed in an object so TS narrows it correctly at each read (a bare `let` mutated only inside the fetchPage closure defeats TS's narrowing).
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
        const rows = parsed.response ?? [];
        const items = rows
          .map((j) => normalizePeoplestrong(company, j))
          .filter((p): p is NormalizedPosting => p !== null);
        // Advance by the raw record count, not the filtered count, so jobs dropped for a missing jobCode don't shorten the page and stop early.
        return { items, total: parsed.totalRecords ?? null, rawCount: rows.length };
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
    const base = tenantOrigin(company);
    const raw = await atsFetchJson(peoplestrongJdUrl(base, posting.externalId), {
      provider: "peoplestrong",
    });
    return parsePeoplestrongJd(raw);
  },
};
