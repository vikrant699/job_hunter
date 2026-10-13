// list: passively-captured POST /TgNewUI/Search/Ajax/MatchedJobs -> { Jobs: { Job: [{ Questions: [{QuestionName,Value}] }] } }; JD inline via ubsField("jobdescription").
import type { Page } from "playwright";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { withBrowserPage } from "./browserFetch.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE } from "./shared.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const DEFAULT_LOCATION = "India";
const NAV_TIMEOUT = 45_000;
const CAPTURE_TIMEOUT = 30_000;

// Value is optional so one Value-less question doesn't zero the whole board.
const UbsQuestionSchema = z.object({ QuestionName: z.string().optional(), Value: JsonValueSchema.optional() });
const UbsJobSchema = z.object({ Questions: z.array(UbsQuestionSchema).optional() });
const MatchedJobsSchema = z.object({
  Jobs: z.object({ Job: z.array(UbsJobSchema).optional() }).optional(),
});
type UbsJob = z.infer<typeof UbsJobSchema>;

const JobsCountSchema = z.object({ JobsCount: z.number() });

// Server's own job count: the only completeness signal, as the response has no paging cursor.
export function ubsReportedJobsCount(payload: JsonValue): number | null {
  const parsed = JobsCountSchema.safeParse(payload);
  return parsed.success ? parsed.data.JobsCount : null;
}

// `parsed` can fall below the raw count (dedup/no-title rows), so only a shortfall against the SERVER's count is reported.
export function ubsTruncationWarning(parsed: number, reported: number | null): string | null {
  if (reported === null || parsed >= reported) return null;
  return `ubs: returned ${parsed} of ${reported} reported jobs — response is truncated`;
}

export function ubsField(job: UbsJob, name: string): string | null {
  const q = job.Questions?.find((x) => x.QuestionName === name);
  const v = q?.Value;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

export function parseUbsMatchedJobs(payload: JsonValue, company: AdapterCompany, homeUrl: string, siteId: string): NormalizedPosting[] {
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
  const decline = page
    .locator("button, a")
    .filter({ hasText: /decline all|reject all|only necessary/i })
    .first();
  await decline.click({ timeout: 3000 }).catch(() => { /* no banner */ });
}

export const ubsAdapter: AtsAdapter = {
  provider: "ubs",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // MatchedJobs is pinned to a single-use per-session token, so drive the UI instead of replaying the API.
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
        const payload: JsonValue = JsonValueSchema.parse(await resp.json());
        const postings = parseUbsMatchedJobs(payload, company, homeUrl, siteId);
        const truncated = ubsTruncationWarning(postings.length, ubsReportedJobsCount(payload));
        if (truncated) logger.warn({ slug: company.slug }, truncated);
        return postings;
      },
      { navTimeoutMs: NAV_TIMEOUT, waitUntil: "networkidle", settleMs: 3000, blockHeavyAssets: false },
    );
  },
};
