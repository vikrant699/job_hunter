// src/ats/reliancebrands.ts — Reliance Brands careers. rblcareers.in redirects
// to Reliance's group-wide "PeopleFirst / OPMP" candidate portal
// (peoplefirst.ril.com), an Angular SPA. Its jobs come from:
//
//   POST https://peoplefirst.ril.com/opmp/api/tagcan-home-i/jobSearch
//     body { pageno, pagesize, filters:[{ match:{ Country:"IN" } }] }
//     -> { status:"Success", result:[ <job> ], total? }
//
// The endpoint is unauthenticated but the origin is WAF-guarded against plain
// Node fetch, so this runs the POST inside the shared headless browser (which
// clears the WAF) — same "load a page, fetch in-page" trick as the other
// browser-backed adapters. Paged by pageno until a short/empty page.
//
// FIELD-MAPPING NOTE: at build time (2026-07-18) the whole RIL portal returned
// `result:[]` for every filter (incl. no filter) — Reliance had no live
// postings anywhere on it — so the per-job field NAMES could not be observed.
// The normalizer therefore reads each field from a list of candidate keys
// (title / location / id / JD / date) rather than fixed names, mirroring the
// directemployers adapter's tolerant approach. It returns [] cleanly today and
// is expected to extract postings once RBL opens a requisition; if the real
// keys fall outside the candidate lists, that surfaces as a 0-count run to fix,
// not a crash. apiMeta.country overrides the country filter (default "IN"),
// apiMeta.subtenant adds a subtenant scope when set.
import type { Page } from "playwright";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { getBrowser, acquirePageSlot } from "../scraper/playwright.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { REMOTE_RE } from "./shared.js";

const JOBSEARCH_URL = "https://peoplefirst.ril.com/opmp/api/tagcan-home-i/jobSearch";
const WARM_URL = "https://peoplefirst.ril.com/ocandidate/";
const PAGE_SIZE = 20;
const MAX_PAGES = 100;

const TITLE_KEYS = ["JobTitle", "jobTitle", "title", "PositionName", "positionName", "Position", "Designation", "designation"];
const ID_KEYS = ["ReqId", "reqId", "reqid", "JobId", "jobId", "id", "PositionId", "RequisitionId", "requisitionId"];
const LOCATION_KEYS = ["Location", "location", "City", "city", "WorkLocation", "workLocation", "JobLocation", "Country", "country"];
const JD_KEYS = ["JobDescription", "jobDescription", "Description", "description", "JD", "jd", "RoleDescription"];
const DATE_KEYS = ["PostedDate", "postedDate", "PostingDate", "postingDate", "CreatedDate", "createdDate", "lastUpdated", "LastUpdated"];

function pick(job: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = job[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function normalizeReliance(company: AdapterCompany, job: Record<string, unknown>): NormalizedPosting | null {
  const jobTitle = pick(job, TITLE_KEYS);
  if (!jobTitle) return null;
  const externalId = pick(job, ID_KEYS) ?? jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const location = pick(job, LOCATION_KEYS);
  const jdRaw = pick(job, JD_KEYS) ?? "";
  return {
    provider: "reliancebrands",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle,
    jobUrl: company.tenantUrl ?? company.careersUrl,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: /<[a-z][\s\S]*>/i.test(jdRaw) ? htmlToText(jdRaw) : jdRaw,
    postedAt: pick(job, DATE_KEYS),
  };
}

function searchBody(pageno: number, country: string, subtenant: string | null): unknown {
  const body: Record<string, unknown> = {
    pageno,
    pagesize: PAGE_SIZE,
    filters: [{ match: { Country: country } }],
  };
  if (subtenant) body.subtenant = subtenant;
  return body;
}

async function postJobSearch(page: Page, body: unknown): Promise<{ result: Record<string, unknown>[] }> {
  return page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = (await r.json()) as { result?: unknown };
      return { result: Array.isArray(j.result) ? (j.result as Record<string, unknown>[]) : [] };
    },
    { url: JOBSEARCH_URL, body },
  );
}

export const reliancebrandsAdapter: AtsAdapter = {
  provider: "reliancebrands",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const country = company.apiMeta?.country ?? "IN";
    const subtenant = company.apiMeta?.subtenant ?? null;

    const release = await acquirePageSlot();
    try {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 },
        locale: "en-US", timezoneId: "Asia/Kolkata",
      });
      try {
        const page = await ctx.newPage();
        page.setDefaultNavigationTimeout(45_000);
        try {
          await page.goto(WARM_URL, { waitUntil: "domcontentloaded" });
        } catch {
          /* WAF interstitial — the in-page POST below still runs in-origin */
        }
        await page.waitForTimeout(5000);

        const out: NormalizedPosting[] = [];
        const seen = new Set<string>();
        for (let pageno = 0; pageno < MAX_PAGES; pageno++) {
          let res: { result: Record<string, unknown>[] };
          try {
            res = await postJobSearch(page, searchBody(pageno, country, subtenant));
          } catch (e) {
            logger.warn({ slug: company.slug, pageno, err: String(e).slice(0, 80) }, "reliancebrands jobSearch failed");
            break;
          }
          const before = out.length;
          for (const job of res.result) {
            const p = normalizeReliance(company, job);
            if (!p || seen.has(p.externalId)) continue;
            seen.add(p.externalId);
            out.push(p);
          }
          if (res.result.length < PAGE_SIZE || out.length === before) break;
        }
        return out;
      } finally {
        await ctx.close();
      }
    } finally {
      release();
    }
  },
};
