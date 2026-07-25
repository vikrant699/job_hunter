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
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { withBrowserPage } from "./browser-fetch.js";
import { htmlToText } from "./html-text.js";
import { REMOTE_RE } from "./shared.js";

const JOBSEARCH_URL = "https://peoplefirst.ril.com/opmp/api/tagcan-home-i/jobSearch";
const WARM_URL = "https://peoplefirst.ril.com/ocandidate/";
const PAGE_SIZE = 20;
const MAX_PAGES = 100;

const TITLE_KEYS = ["JobTitle", "jobTitle", "title", "PositionName", "positionName", "Position", "Designation", "designation"];
const ID_KEYS = ["ReqId", "reqId", "reqid", "JobId", "jobId", "id", "PositionId", "RequisitionId", "requisitionId"];
const LOCATION_KEYS = ["Location", "location", "City", "city", "WorkLocation", "workLocation", "JobLocation"];
// Kept OUT of LOCATION_KEYS: a bare ISO code like "IN" (exactly what this
// adapter's own filter sends) carries no signal the pipeline's checkLocation()
// can match — the profile's hints are "india" / "in," — so surfacing it as the
// whole location would drop an India-only req as out-of-region. It is expanded
// and appended to the city instead (see `composeLocation`).
const COUNTRY_KEYS = ["Country", "country", "CountryCode", "countryCode"];
/** Only the codes this adapter actually filters on; anything else is passed
 *  through verbatim rather than guessed at. */
const COUNTRY_CODE_NAMES: Record<string, string> = { IN: "India" };
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

/** City-ish location plus the country, de-duplicated: "Mumbai" + "IN" ->
 *  "Mumbai, India". Either half may be absent; null when both are. */
export function composeLocation(city: string | null, country: string | null): string | null {
  const countryName = country ? (COUNTRY_CODE_NAMES[country.toUpperCase()] ?? country) : null;
  if (!city) return countryName;
  if (!countryName) return city;
  return new RegExp(`\\b${countryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(city)
    ? city
    : `${city}, ${countryName}`;
}

export function normalizeReliance(company: AdapterCompany, job: Record<string, unknown>): NormalizedPosting | null {
  const jobTitle = pick(job, TITLE_KEYS);
  if (!jobTitle) return null;
  const externalId = pick(job, ID_KEYS) ?? jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const location = composeLocation(pick(job, LOCATION_KEYS), pick(job, COUNTRY_KEYS));
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

const JobRowSchema = z.record(z.unknown());

async function postJobSearch(page: Page, body: unknown): Promise<{ result: unknown[] }> {
  return page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j: unknown = await r.json();
      const result: unknown[] =
        j !== null && typeof j === "object" && "result" in j && Array.isArray(j.result) ? j.result : [];
      return { result };
    },
    { url: JOBSEARCH_URL, body },
  );
}

export const reliancebrandsAdapter: AtsAdapter = {
  provider: "reliancebrands",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const country = company.apiMeta?.country ?? "IN";
    const subtenant = company.apiMeta?.subtenant ?? null;

    return withBrowserPage(
      WARM_URL,
      async (page) => {
        const out: NormalizedPosting[] = [];
        const seen = new Set<string>();
        for (let pageno = 0; pageno < MAX_PAGES; pageno++) {
          let res: { result: unknown[] };
          try {
            res = await postJobSearch(page, searchBody(pageno, country, subtenant));
          } catch (e) {
            logger.warn({ slug: company.slug, pageno, err: String(e).slice(0, 80) }, "reliancebrands jobSearch failed");
            break;
          }
          const before = out.length;
          for (const row of res.result) {
            const job = JobRowSchema.safeParse(row);
            if (!job.success) continue;
            const p = normalizeReliance(company, job.data);
            if (!p || seen.has(p.externalId)) continue;
            seen.add(p.externalId);
            out.push(p);
          }
          if (res.result.length < PAGE_SIZE || out.length === before) break;
        }
        return out;
      },
      // WAF interstitial on goto is swallowed (default) — the in-page POST
      // below still runs in-origin even if the initial nav "failed".
      { navTimeoutMs: 45_000, blockHeavyAssets: false },
    );
  },
};
