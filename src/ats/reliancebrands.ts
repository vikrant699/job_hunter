// src/ats/reliancebrands.ts — Reliance Brands careers. rblcareers.in redirects to Reliance's
// group-wide "PeopleFirst / OPMP" candidate portal (peoplefirst.ril.com), an Angular SPA. Jobs come
// from POST https://peoplefirst.ril.com/opmp/api/tagcan-home-i/jobSearch, unauthenticated but
// WAF-guarded against plain Node fetch, so this runs the POST inside the shared headless browser.
// The whole portal had zero live postings at build time, so per-job field NAMES could not be
// observed; the normalizer reads each field from a list of candidate keys rather than fixed names.
// apiMeta.country overrides the country filter (default "IN"), apiMeta.subtenant scopes further.
import type { Page } from "playwright";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { withBrowserPage } from "./browserFetch.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE, DEFAULT_MAX_PAGES, paginate } from "./shared.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const JOBSEARCH_URL = "https://peoplefirst.ril.com/opmp/api/tagcan-home-i/jobSearch";
const WARM_URL = "https://peoplefirst.ril.com/ocandidate/";
const PAGE_SIZE = 20;

const TITLE_KEYS = ["JobTitle", "jobTitle", "title", "PositionName", "positionName", "Position", "Designation", "designation"];
const ID_KEYS = ["ReqId", "reqId", "reqid", "JobId", "jobId", "id", "PositionId", "RequisitionId", "requisitionId"];
const LOCATION_KEYS = ["Location", "location", "City", "city", "WorkLocation", "workLocation", "JobLocation"];
// Kept out of LOCATION_KEYS: a bare ISO code like "IN" carries no signal checkLocation() can match
// against the profile's "india"/"in," hints, so it's expanded and appended to the city instead (see composeLocation).
const COUNTRY_KEYS = ["Country", "country", "CountryCode", "countryCode"];
// Only the codes this adapter actually filters on; anything else passes through verbatim.
const COUNTRY_CODE_NAMES: Record<string, string> = { IN: "India" };
const JD_KEYS = ["JobDescription", "jobDescription", "Description", "description", "JD", "jd", "RoleDescription"];
const DATE_KEYS = ["PostedDate", "postedDate", "PostingDate", "postingDate", "CreatedDate", "createdDate", "lastUpdated", "LastUpdated"];

function pick(job: Record<string, JsonValue>, keys: string[]): string | null {
  for (const k of keys) {
    const v = job[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

// City-ish location plus the country, deduplicated: "Mumbai" + "IN" -> "Mumbai, India".
export function composeLocation(city: string | null, country: string | null): string | null {
  const countryName = country ? (COUNTRY_CODE_NAMES[country.toUpperCase()] ?? country) : null;
  if (!city) return countryName;
  if (!countryName) return city;
  return new RegExp(`\\b${countryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(city)
    ? city
    : `${city}, ${countryName}`;
}

export function normalizeReliance(company: AdapterCompany, job: Record<string, JsonValue>): NormalizedPosting | null {
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

function searchBody(pageno: number, country: string, subtenant: string | null): JsonValue {
  const body: Record<string, JsonValue> = {
    pageno,
    pagesize: PAGE_SIZE,
    filters: [{ match: { Country: country } }],
  };
  if (subtenant) body.subtenant = subtenant;
  return body;
}

const JobRowSchema = z.record(z.string(), JsonValueSchema);

async function postJobSearch(page: Page, body: JsonValue): Promise<{ result: JsonValue[] }> {
  // Both the Arg and the return cross the Playwright boundary as strings: a
  // JsonValue-typed Arg makes Playwright's recursive Unboxed<Arg> mapped type
  // recurse into JsonValue's own recursive union and exceed TS's
  // instantiation-depth limit (same reason as browserFetch.ts). Validating the
  // response text back on the Node side also keeps the parse in one place.
  const bodyJson = JSON.stringify(body);
  const raw = await page.evaluate(
    async ({ url, bodyJson }) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: bodyJson,
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    },
    { url: JOBSEARCH_URL, bodyJson },
  );
  const j = JsonValueSchema.parse(JSON.parse(raw));
  const result =
    j !== null && typeof j === "object" && !Array.isArray(j) && Array.isArray(j.result) ? j.result : [];
  return { result };
}

export const reliancebrandsAdapter: AtsAdapter = {
  provider: "reliancebrands",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const country = company.apiMeta?.country ?? "IN";
    const subtenant = company.apiMeta?.subtenant ?? null;

    return withBrowserPage(
      WARM_URL,
      async (browserPage) => {
        return paginate<NormalizedPosting>({
          provider: "reliancebrands",
          company: company.slug,
          pageSize: PAGE_SIZE,
          maxPages: DEFAULT_MAX_PAGES,
          dedupeBy: (p) => p.externalId,
          fetchPage: async (_offset, pageno) => {
            let res: { result: JsonValue[] };
            try {
              res = await postJobSearch(browserPage, searchBody(pageno, country, subtenant));
            } catch (e) {
              logger.warn({ slug: company.slug, pageno, err: String(e).slice(0, 80) }, "reliancebrands jobSearch failed");
              return { items: [], total: null };
            }
            const items: NormalizedPosting[] = [];
            for (const row of res.result) {
              const job = JobRowSchema.safeParse(row);
              if (!job.success) continue;
              const p = normalizeReliance(company, job.data);
              if (p) items.push(p);
            }
            return { items, rawCount: res.result.length, total: null };
          },
        });
      },
      // WAF interstitial on goto is swallowed (default) — the in-page POST
      // below still runs in-origin even if the initial nav "failed".
      { navTimeoutMs: 45_000, blockHeavyAssets: false },
    );
  },
};
