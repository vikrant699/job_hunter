// src/ats/ubs.ts — UBS careers, an IBM Kenexa BrassRing "Talent Gateway"
// (TGnewUI). The job data comes from a POST /TgNewUI/Search/Ajax/MatchedJobs
// call, but that call is pinned to a single-use per-session `rft` +
// `encryptedsessionvalue` that a replayed request can't reproduce (a hand-
// built POST 500s). So instead of replaying the API, this adapter drives the
// site's OWN search UI in the shared headless browser and passively captures
// the response the page fires:
//
//   1. load /TGnewUI/Search/home/Home?partnerid=<pid>&siteid=<sid>
//   2. decline the consent banner, type the location filter (default
//      "India") into the location box, click Search
//   3. capture the MatchedJobs JSON response the SPA fires
//
// Response shape: { Jobs: { Job: [{ Questions: [{QuestionName,Value}] }] } }.
// Each job's Questions carry reqid, jobtitle, jobdescription (full JD inline),
// formtext23 (location), formtext21 (job function), department, lastupdated.
// Server-side location filtering returns the full India set in one response
// (20 at the 2026-07-25 audit, matching the site's own "20 India results"), so
// no pagination is needed today. The response DOES cap at 50 jobs, though —
// verified by searching with no location filter: `JobsCount=577`, 50 returned.
// There is no paging cursor (`TotalJobsCount`/`PageSize` are both 0), so a
// crossing of that cap is detected, not repaired: `ubsTruncationWarning` logs
// the shortfall against the server's own `JobsCount`. Recovering the remainder
// would need UI "show more" driving, or splitting the search across the city
// facets the response returns.
//
// apiMeta.location overrides the search term (default "India"). partnerid /
// siteid are read from the careers URL's query string.
import type { Page } from "playwright";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { withBrowserPage } from "./browser-fetch.js";
import { htmlToText } from "./html-text.js";
import { REMOTE_RE } from "./shared.js";
import { JsonValueSchema } from "../util/json.js";

const DEFAULT_LOCATION = "India";
const NAV_TIMEOUT = 45_000;
const CAPTURE_TIMEOUT = 30_000;

const UbsQuestionSchema = z.object({ QuestionName: z.string().optional(), Value: JsonValueSchema });
const UbsJobSchema = z.object({ Questions: z.array(UbsQuestionSchema).optional() });
const MatchedJobsSchema = z.object({
  Jobs: z.object({ Job: z.array(UbsJobSchema).optional() }).optional(),
});
type UbsJob = z.infer<typeof UbsJobSchema>;

const JobsCountSchema = z.object({ JobsCount: z.number() });

/** The server's own job count for the executed search, or null when absent.
 *  This is the only completeness signal available: the response has no paging
 *  cursor, and `TotalJobsCount`/`PageSize` come back as 0. */
export function ubsReportedJobsCount(payload: unknown): number | null {
  const parsed = JobsCountSchema.safeParse(payload);
  return parsed.success ? parsed.data.JobsCount : null;
}

/**
 * The truncation message to log, or null when the response looks complete.
 *
 * The MatchedJobs response caps at 50 jobs — verified live 2026-07-25: an
 * unfiltered search reports `JobsCount=577` and returns exactly 50 (the site's
 * own UI says "Refine 50 results"). India sits at 20 today, so nothing is lost,
 * but this adapter has no pagination: were the India set to cross the cap the
 * loss would otherwise be completely silent.
 *
 * `parsed` can legitimately fall below the raw array length (dedup / rows with
 * no title), so only a shortfall against the SERVER's count is reported.
 */
export function ubsTruncationWarning(parsed: number, reported: number | null): string | null {
  if (reported === null || parsed >= reported) return null;
  return `ubs: returned ${parsed} of ${reported} reported jobs — response is truncated`;
}

/** Read one Questions field's value as a trimmed string. */
export function ubsField(job: UbsJob, name: string): string | null {
  const q = job.Questions?.find((x) => x.QuestionName === name);
  const v = q?.Value;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

/** Parse the MatchedJobs payload into normalized postings. Pure/testable. */
export function parseUbsMatchedJobs(payload: unknown, company: AdapterCompany, homeUrl: string, siteId: string): NormalizedPosting[] {
  const parsed = MatchedJobsSchema.safeParse(payload);
  const jobs = parsed.success ? parsed.data.Jobs?.Job ?? [] : [];
  const out: NormalizedPosting[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    const reqid = ubsField(job, "reqid");
    const jobTitle = ubsField(job, "jobtitle");
    if (!reqid || !jobTitle || seen.has(reqid)) continue;
    seen.add(reqid);
    const location = ubsField(job, "formtext23");
    const jdRaw = ubsField(job, "jobdescription") ?? "";
    out.push({
      provider: "ubs",
      externalId: reqid,
      companySlug: company.slug,
      companyName: company.name,
      jobTitle,
      jobUrl: `${homeUrl}#jobDetails=${reqid}_${siteId}`,
      location,
      isRemote: location ? REMOTE_RE.test(location) : false,
      jdText: /<[a-z][\s\S]*>/i.test(jdRaw) ? htmlToText(jdRaw) : jdRaw.trim(),
      postedAt: ubsField(job, "lastupdated"),
    });
  }
  return out;
}

async function dismissConsent(page: Page): Promise<void> {
  // Best-effort: decline non-essential cookies so the banner can't block clicks.
  const decline = page
    .locator("button, a")
    .filter({ hasText: /decline all|reject all|only necessary/i })
    .first();
  await decline.click({ timeout: 3000 }).catch(() => { /* no banner */ });
}

export const ubsAdapter: AtsAdapter = {
  provider: "ubs",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const homeUrl = company.tenantUrl ?? company.careersUrl;
    const siteId = new URL(homeUrl).searchParams.get("siteid") ?? "";
    const location = company.apiMeta?.location ?? DEFAULT_LOCATION;

    return withBrowserPage(
      homeUrl,
      async (page) => {
        await dismissConsent(page);
        await page.waitForTimeout(500);

        const locInput = page.locator("input[name='locationSearch']").first();
        await locInput.fill(location).catch(() => { /* selector drift handled by the empty-capture guard */ });

        const capture = page
          .waitForResponse((r) => /MatchedJobs/i.test(r.url()) && r.status() === 200, { timeout: CAPTURE_TIMEOUT })
          .catch(() => null);
        await page.locator("#clearResumeJobsBtn").first().click().catch(() => { /* fall through */ });

        const resp = await capture;
        if (!resp) {
          logger.warn({ slug: company.slug }, "ubs: no MatchedJobs response captured");
          return [];
        }
        const payload: unknown = await resp.json();
        const postings = parseUbsMatchedJobs(payload, company, homeUrl, siteId);
        const truncated = ubsTruncationWarning(postings.length, ubsReportedJobsCount(payload));
        if (truncated) logger.warn({ slug: company.slug }, truncated);
        return postings;
      },
      // WAF/consent settle on goto is swallowed (default); the 3000ms settle
      // (matching the original inline wait) runs before the UI-driving above.
      { navTimeoutMs: NAV_TIMEOUT, waitUntil: "networkidle", settleMs: 3000, blockHeavyAssets: false },
    );
  },
};
