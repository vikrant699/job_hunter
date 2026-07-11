// src/ats/ripplehire.ts — RippleHire candidate career boards, e.g.
// <tenant>.ripplehire.com (UST/usource, Tata Steel/tatasteel).
//
// Token discovery: GET /candidate/careers 302s to
// /candidate/?token=<TOKEN>&source=CAREERSITE. That token is a permanent
// per-tenant short-link code (not a session secret) — stable across fresh,
// cookie-less requests — so we discover it once (or read it from
// apiMeta.token when already cached) and reuse it for every call.
//
//   list: POST https://<tenant>.ripplehire.com/candidate/candidatejobsearch
//         Content-Type: application/x-www-form-urlencoded
//         body: careerSiteUrlParams={"page":N,"search":"*:*","token":"<TOKEN>",
//                                     "source":"CAREERSITE","pagesize":100}
//               &lang=en
//         -> { startJobIndex, maxJobSize, totalJobCount,
//              jobVoList: [ { jobSeq, jobTitle, locations, jobPostingDate, ... } ] }
//         NOTE: the server replies with XML unless the request sends
//         Accept: application/json — atsFetchFormJson always does.
//
//   jd:   GET https://<tenant>.ripplehire.com/candidate/candidatejobdetail
//              ?token=<TOKEN>&jobSeq=<id>&source=CAREERSITE&lang=en
//         -> { jobVO: { jobDesc: "<html>", ... } }
//
// externalId = jobSeq (falls back to jobId; both are the same value on every
// tenant observed so far, but jobSeq is what the detail endpoint expects).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, atsFetchFormJson, atsFetchHtml } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const PAGE = 100; // requested page size; the server honors it (confirmed on UST's 1355-job board)
// Largest known tenant (UST/usource) is ~1355 jobs -> ~14 pages at PAGE=100;
// 40 pages (~4000 jobs) leaves generous headroom. listPostings warns if hit.
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

export const RipplehireJobSchema = z.object({
  jobSeq: z.union([z.string(), z.number()]).nullable().optional(),
  jobId: z.union([z.string(), z.number()]).nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  jobCode: z.string().nullable().optional(),
  locations: z.string().nullable().optional(),
  jobLocation: z.string().nullable().optional(),
  jobPostingDate: z.string().nullable().optional(),
  createDttm: z.string().nullable().optional(),
});
export type RipplehireJob = z.infer<typeof RipplehireJobSchema>;

export const RipplehireListSchema = z.object({
  startJobIndex: z.number().nullable().optional(),
  maxJobSize: z.number().nullable().optional(),
  totalJobCount: z.number().nullable().optional(),
  jobVoList: z.array(RipplehireJobSchema).nullable().optional(),
});

export const RipplehireJdSchema = z.object({
  jobVO: z
    .object({ jobDesc: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

/** Origin (https://<tenant>.ripplehire.com) from the tenant/careers URL. */
export function ripplehireBase(company: AdapterCompany): string {
  return new URL(company.tenantUrl ?? company.careersUrl).origin;
}

/** Extract the `token` query param from a URL string. Null if absent or unparseable. */
export function extractRipplehireToken(url: string): string | null {
  try {
    return new URL(url).searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * Discover the tenant's static candidate-portal token by following the
 * /candidate/careers -> /candidate/?token=...&source=CAREERSITE redirect.
 * Null on any failure (network error, or no token in the resolved URL).
 */
export async function discoverRipplehireToken(base: string): Promise<string | null> {
  try {
    const { finalUrl } = await atsFetchHtml(`${base}/candidate/careers`, { provider: "ripplehire" });
    return extractRipplehireToken(finalUrl);
  } catch {
    return null;
  }
}

/** Resolve the token to use for a company: prefer the cached apiMeta value, else discover it fresh. */
export async function resolveRipplehireToken(company: AdapterCompany, base: string): Promise<string> {
  const cached = company.apiMeta?.token;
  if (cached) return cached;
  const discovered = await discoverRipplehireToken(base);
  if (!discovered) throw new Error(`ripplehire adapter: could not discover token for ${company.slug}`);
  return discovered;
}

export function ripplehireListUrl(base: string): string {
  return `${base}/candidate/candidatejobsearch`;
}

/** Form body for the paged search endpoint (application/x-www-form-urlencoded). */
export function ripplehireListBody(token: string, page: number, pagesize = PAGE): Record<string, string> {
  return {
    careerSiteUrlParams: JSON.stringify({ page, search: "*:*", token, source: "CAREERSITE", pagesize }),
    lang: "en",
  };
}

export function ripplehireJdUrl(base: string, token: string, jobSeq: string): string {
  return (
    `${base}/candidate/candidatejobdetail?token=${encodeURIComponent(token)}` +
    `&jobSeq=${encodeURIComponent(jobSeq)}&source=CAREERSITE&lang=en`
  );
}

/** Token-bearing candidate board link. RippleHire exposes no per-job public
 *  deep link in the API response, so every posting on a tenant links here —
 *  the confirmed-working board a candidate lands on and can search/browse. */
export function ripplehireBoardUrl(base: string, token: string): string {
  return `${base}/candidate/?token=${encodeURIComponent(token)}&source=CAREERSITE`;
}

/** Date-only strings ("2026-07-01"). Null-safe; returns null on unparseable input. */
function parseRipplehireDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Map one API job to a NormalizedPosting. Null when the job has neither
 *  jobSeq nor jobId (no stable id / JD key), so the caller can skip it. */
export function normalizeRipplehire(
  company: AdapterCompany,
  token: string,
  j: RipplehireJob,
): NormalizedPosting | null {
  const externalId = j.jobSeq != null ? String(j.jobSeq) : j.jobId != null ? String(j.jobId) : null;
  if (!externalId) return null;
  const location = j.locations ?? j.jobLocation ?? null;
  return {
    provider: "ripplehire",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle ?? "",
    jobUrl: ripplehireBoardUrl(ripplehireBase(company), token),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: parseRipplehireDate(j.jobPostingDate ?? j.createDttm),
  };
}

/** Extract the JD body HTML from a job-detail response and strip to plain text. */
export function parseRipplehireJd(raw: unknown): string {
  const parsed = RipplehireJdSchema.safeParse(raw);
  if (!parsed.success) return "";
  return htmlToText(parsed.data.jobVO?.jobDesc ?? "");
}

export const ripplehireAdapter: AtsAdapter = {
  provider: "ripplehire",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = ripplehireBase(company);
    const token = await resolveRipplehireToken(company, base);
    let total: number | null = null;

    const postings = await paginate<NormalizedPosting>({
      provider: "ripplehire",
      company: company.slug,
      pageSize: PAGE,
      maxPages: MAX_PAGES,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchFormJson(ripplehireListUrl(base), ripplehireListBody(token, page), {
          provider: "ripplehire",
        });
        const parsed = RipplehireListSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { slug: company.slug, page, issues: parsed.error.issues.slice(0, 2) },
            "ripplehire list schema mismatch",
          );
          throw new Error(`ripplehire list response failed schema for ${company.slug}`);
        }
        if (total === null && typeof parsed.data.totalJobCount === "number") {
          total = parsed.data.totalJobCount;
        }
        const rawJobs = parsed.data.jobVoList ?? [];
        const items = rawJobs
          .map((j) => normalizeRipplehire(company, token, j))
          .filter((p): p is NormalizedPosting => p !== null);
        // Advance by the raw record count, not the filtered count, so jobs
        // dropped for a missing id don't shorten the page and stop early.
        return { items, total: parsed.data.totalJobCount ?? null, rawCount: rawJobs.length };
      },
    });

    if (total !== null && Math.ceil(total / PAGE) > MAX_PAGES) {
      logger.warn(
        { slug: company.slug, collected: postings.length, total, maxPages: MAX_PAGES },
        "ripplehire pagination capped — board larger than the safety limit",
      );
    } else if (total !== null && postings.length < total) {
      logger.info(
        { slug: company.slug, collected: postings.length, total },
        "ripplehire collected fewer postings than totalJobCount — some jobs had no id",
      );
    }

    return postings;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const base = ripplehireBase(company);
    const token = await resolveRipplehireToken(company, base);
    const raw = await atsFetchJson(ripplehireJdUrl(base, token, posting.externalId), { provider: "ripplehire" });
    return parseRipplehireJd(raw);
  },
};
