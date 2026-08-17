// src/ats/ripplehire.ts — RippleHire candidate career boards (<tenant>.ripplehire.com). Token
// discovery: GET /candidate/careers 302s to /candidate/?token=<TOKEN>&source=CAREERSITE, a permanent
// per-tenant short-link code (not a session secret), discovered once and reused. List endpoint
// replies with XML unless the request sends Accept: application/json (atsFetchFormJson always does).
// externalId is jobSeq (falls back to jobId — same value on every tenant seen, but jobSeq is what
// the detail endpoint expects).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchFormJson, atsFetchHtml, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin } from "./shared.js";
import type { JsonValue } from "../util/json.js";

const PAGE = 100; // requested page size; the server honors it
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

export function extractRipplehireToken(url: string): string | null {
  try {
    return new URL(url).searchParams.get("token");
  } catch {
    return null;
  }
}

export async function discoverRipplehireToken(base: string): Promise<string | null> {
  try {
    const { finalUrl } = await atsFetchHtml(`${base}/candidate/careers`, { provider: "ripplehire" });
    return extractRipplehireToken(finalUrl);
  } catch {
    return null;
  }
}

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

// RippleHire exposes no per-job public deep link, so every posting on a tenant links to the board.
export function ripplehireBoardUrl(base: string, token: string): string {
  return `${base}/candidate/?token=${encodeURIComponent(token)}&source=CAREERSITE`;
}

// Null when the job has neither jobSeq nor jobId (no stable id / JD key), so the caller can skip it.
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
    jobUrl: ripplehireBoardUrl(tenantOrigin(company), token),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: dateToIso(j.jobPostingDate ?? j.createDttm),
  };
}

export function parseRipplehireJd(raw: JsonValue): string {
  const parsed = RipplehireJdSchema.safeParse(raw);
  if (!parsed.success) return "";
  return htmlToText(parsed.data.jobVO?.jobDesc ?? "");
}

export const ripplehireAdapter: AtsAdapter = {
  provider: "ripplehire",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const base = tenantOrigin(company);
    const token = await resolveRipplehireToken(company, base);
    // Boxed in an object so TS narrows it correctly at each read (a bare `let` mutated only inside
    // the fetchPage closure defeats TS's narrowing).
    const state: { total: number | null } = { total: null };

    const postings = await paginate<NormalizedPosting>({
      provider: "ripplehire",
      company: company.slug,
      pageSize: PAGE,
      maxPages: MAX_PAGES,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchFormJson(ripplehireListUrl(base), ripplehireListBody(token, page), {
          provider: "ripplehire",
        });
        const parsed = parseOrThrow(RipplehireListSchema, raw, {
          provider: "ripplehire",
          slug: company.slug,
          what: `list (page ${page})`,
        });
        if (state.total === null && typeof parsed.totalJobCount === "number") {
          state.total = parsed.totalJobCount;
        }
        const rawJobs = parsed.jobVoList ?? [];
        const items = rawJobs
          .map((j) => normalizeRipplehire(company, token, j))
          .filter((p): p is NormalizedPosting => p !== null);
        // Advance by the raw record count, not the filtered count, so jobs
        // dropped for a missing id don't shorten the page and stop early.
        return { items, total: parsed.totalJobCount ?? null, rawCount: rawJobs.length };
      },
    });

    const total = state.total;
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
    const base = tenantOrigin(company);
    const token = await resolveRipplehireToken(company, base);
    const raw = await atsFetchJson(ripplehireJdUrl(base, token, posting.externalId), { provider: "ripplehire" });
    return parseRipplehireJd(raw);
  },
};
