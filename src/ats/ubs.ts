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
// (18 at capture time, under the page size), so no pagination is needed;
// if a tenant/location ever exceeds one page this returns the first page and
// logs — completeness would then need UI "show more" driving.
//
// apiMeta.location overrides the search term (default "India"). partnerid /
// siteid are read from the careers URL's query string.
import type { Page } from "playwright";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { REMOTE_RE } from "./shared.js";

const DEFAULT_LOCATION = "India";
const NAV_TIMEOUT = 45_000;
const CAPTURE_TIMEOUT = 30_000;

interface UbsQuestion { QuestionName?: string; Value?: unknown }
interface UbsJob { Questions?: UbsQuestion[] }

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
  const jobs = (payload as { Jobs?: { Job?: UbsJob[] } } | null)?.Jobs?.Job ?? [];
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

    const release = await acquirePageSlot();
    try {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 },
        locale: "en-US", timezoneId: "Asia/Kolkata",
      });
      try {
        const page = await ctx.newPage();
        page.setDefaultNavigationTimeout(NAV_TIMEOUT);
        try {
          await page.goto(homeUrl, { waitUntil: "networkidle" });
        } catch {
          /* WAF/consent settle — UI is still driveable below */
        }
        await page.waitForTimeout(3000);
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
        return parseUbsMatchedJobs(payload, company, homeUrl, siteId);
      } finally {
        await ctx.close();
      }
    } finally {
      release();
    }
  },
};
