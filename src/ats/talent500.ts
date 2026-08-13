// src/ats/talent500.ts — Talent500 (by ANSR), a shared JSON REST job-board
// aggregator hosting many India GCCs (Global Capability Centers) on one host:
//
//   list:   GET https://prod-warmachine.talent500.co/api/v3/jobs/search/
//                ?company_slug=<slug>&offset=<N>&size=<SIZE>
//           -> { total: <int>, data: [ <job>, ... ] }
//           Paginate offset += size while offset < total (and the page still
//           returns rows). No auth; company_slug is the registry source_slug.
//
//   detail: GET https://prod-warmachine.talent500.co/api/jobs/<job.slug>/
//           -> { role_summary, description, responsibilities,
//                what_you_need_to_succeed, typical_workday, what_you_offer }
//           (all optional HTML strings). The JD is built by concatenating,
//           in order, whichever of [role_summary, description,
//           responsibilities, what_you_need_to_succeed] are present and
//           non-empty, then stripping HTML.
//
//   public job URL: https://talent500.com/jobs/<job.slug> (no auth, used both
//   as jobUrl and as the source of the slug fetchJd needs — the API's `id` is
//   a uuid, not usable against the detail endpoint).
//
// Listed jobs are filtered to is_job_displayable !== false, is_active !==
// false, and status !== "closed" — undisplayable/inactive/closed rows are
// dropped. No country filter here: the board is already India-scoped and the
// pipeline's own location gate handles the rest.
//
// DEAD TENANTS: company_slug is a filter on a shared aggregator, and an unknown
// value is silently DROPPED rather than rejected — the response is then every
// employer's jobs at HTTP 200. Page 1 is therefore audited two ways before the
// crawl is trusted; see talent500FilterWasIgnored and assertTalent500TenantExists.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow, withAtsTimeout } from "./http.js";
import { config } from "../config.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const API_ORIGIN = "https://prod-warmachine.talent500.co";
const PUBLIC_JOB_ORIGIN = "https://talent500.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

const TalentCountrySchema = z.object({
  name: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
});

// The employer each job belongs to. Only `slug` is read, and only to verify the
// server honored our company_slug filter — see talent500FilterWasIgnored.
const TalentJobCompanySchema = z.object({
  slug: z.string().nullable().optional(),
});

const TalentJobSchema = z.object({
  id: z.string(),
  title_alias_1: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  slug: z.string(),
  company: TalentJobCompanySchema.nullable().optional(),
  location: z.string().nullable().optional(),
  country: TalentCountrySchema.nullable().optional(),
  is_remote: z.boolean().nullable().optional(),
  created_at: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
  is_job_displayable: z.boolean().nullable().optional(),
});
export type Talent500Job = z.infer<typeof TalentJobSchema>;

const TalentListSchema = z.object({
  total: z.number().nullable().optional(),
  data: z.array(TalentJobSchema),
  /** Elasticsearch-style cursor for the NEXT page. The server IGNORES the
   *  offset param (verified 2026-08-13: every offset re-serves page 1, which
   *  silently truncated eight GCC boards to their first 50 rows), so this is
   *  the only real pagination mechanism. */
  search_after: z.array(z.union([z.number(), z.string()])).nullable().optional(),
});

const TalentDetailSchema = z.object({
  role_summary: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  responsibilities: z.string().nullable().optional(),
  what_you_need_to_succeed: z.string().nullable().optional(),
  typical_workday: z.string().nullable().optional(),
  what_you_offer: z.string().nullable().optional(),
});
export type Talent500Detail = z.infer<typeof TalentDetailSchema>;

/** Build the paged list-search URL for one company. Pages after the first
 *  paginate via the server's `search_after` cursor (JSON array, URL-encoded);
 *  the `offset` param is kept for the first call's shape but the server
 *  ignores it, so the cursor is what actually advances. */
export function talent500ListUrl(
  companySlug: string,
  offset: number,
  size: number = PAGE_SIZE,
  searchAfter: ReadonlyArray<number | string> | null = null,
): string {
  const base = `${API_ORIGIN}/api/v3/jobs/search/?company_slug=${encodeURIComponent(companySlug)}&offset=${offset}&size=${size}`;
  return searchAfter === null ? base : `${base}&search_after=${encodeURIComponent(JSON.stringify(searchAfter))}`;
}

/** Build the job-detail URL from a job's slug (NOT its uuid `id`). */
export function talent500DetailUrl(jobSlug: string): string {
  return `${API_ORIGIN}/api/jobs/${encodeURIComponent(jobSlug)}/`;
}

/** The company-profile endpoint, used solely as an existence oracle. */
export function talent500CompanyUrl(companySlug: string): string {
  return `${API_ORIGIN}/api/companies/${encodeURIComponent(companySlug)}/`;
}

/**
 * True when the server plainly did NOT apply our `company_slug` filter.
 *
 * The list endpoint does not reject an unknown company_slug — it silently drops
 * the filter and serves the whole aggregator. Probed 2026-08-02, every one of
 * `zzz-no-such-tenant-9x`, `acmewidgetsco`, `nokia-india-gcc` and `""` returned
 * HTTP 200 with total=6190 and rows from aatechhubindia / albertsonsindia /
 * summit-consulting. So a dead slug does not merely under-report: it would
 * attribute ~6,000 other employers' postings to this company. `nokia` returned
 * total=73, matching its own open_jobs_count, so a LIVE slug really is filtered.
 *
 * Every row carries the employer it belongs to, so the response audits itself:
 * we require at least one row to actually be this company's. Rows that carry no
 * company object at all (a payload change) leave the question unanswerable, and
 * this deliberately returns false there rather than failing a working board.
 */
export function talent500FilterWasIgnored(rows: readonly Talent500Job[], companySlug: string): boolean {
  const rowSlugs = rows.map((r) => r.company?.slug).filter((s): s is string => typeof s === "string" && s !== "");
  if (rowSlugs.length === 0) return false;
  return !rowSlugs.includes(companySlug);
}

/**
 * Throw if the company-profile endpoint says this slug does not exist.
 *
 * Only a definitive 404 counts. That endpoint also answers 400 "Not Published"
 * for companies that exist but have no public profile — 15 of the 85 live rows
 * (aramco, bp, zillow, kaspersky, …) on 2026-08-02 — so treating anything other
 * than 404 as non-existence would quarantine those healthy boards. A transport
 * failure or a 5xx on this secondary probe is likewise ignored: the list call
 * already succeeded, and an outage here says nothing about the tenant.
 */
export async function assertTalent500TenantExists(companySlug: string): Promise<void> {
  const url = talent500CompanyUrl(companySlug);
  let status: number;
  try {
    // Raw fetch (not atsFetchJson): the status IS the signal here, and
    // atsFetchJson turns every non-2xx into a throw before we can read it.
    const res = await withAtsTimeout((signal) =>
      fetch(url, { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" }, signal }),
    );
    status = res.status;
  } catch {
    return; // probe itself failed — says nothing about the tenant
  }
  if (status === 404) {
    throw new Error(
      `talent500: tenant does not exist at ${url} — the company profile is absent, and the list ` +
        `endpoint answers an unknown company_slug with the whole unfiltered aggregator feed rather ` +
        `than an empty board. Slug "${companySlug}" is dead, not the board empty.`,
    );
  }
}

/** Public job page URL — also what fetchJd derives the detail slug from. */
export function talent500JobUrl(jobSlug: string): string {
  return `${PUBLIC_JOB_ORIGIN}/jobs/${jobSlug}`;
}

/** Keep a job only if it's displayable, active, and not closed. */
export function talent500ShouldKeep(j: Talent500Job): boolean {
  if (j.is_job_displayable === false) return false;
  if (j.is_active === false) return false;
  if (j.status === "closed") return false;
  return true;
}

export function normalizeTalent500Job(company: AdapterCompany, j: Talent500Job): NormalizedPosting {
  const location = j.location ?? null;
  return {
    provider: "talent500",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: (j.title_alias_1 && j.title_alias_1.trim()) || (j.title && j.title.trim()) || "",
    jobUrl: talent500JobUrl(j.slug),
    location,
    isRemote: j.is_remote === true || REMOTE_RE.test(location ?? ""),
    jdText: "",
    // created_at ("2026-06-24T14:51:54.811468+05:30") is the only reliable
    // timestamp field; `posted_on` is a relative string like "19 days ago"
    // and is intentionally never used.
    postedAt: dateToIso(j.created_at),
  };
}

/** Derive the job-detail slug from a posting's public jobUrl
 *  (…talent500.com/jobs/<slug>) — the last non-empty path segment. */
export function talent500SlugFromUrl(jobUrl: string): string {
  const parts = new URL(jobUrl).pathname.split("/").filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) throw new Error(`talent500: could not derive job slug from jobUrl "${jobUrl}"`);
  return slug;
}

/** Build the plain-text JD by concatenating, in order, whichever of
 *  [role_summary, description, responsibilities, what_you_need_to_succeed]
 *  are present and non-empty, then stripping HTML. Throws if none yield text. */
export function buildTalent500Jd(detail: Talent500Detail): string {
  const parts = [detail.role_summary, detail.description, detail.responsibilities, detail.what_you_need_to_succeed]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (parts.length === 0) throw new Error("talent500: job detail had no JD-bearing fields");
  return htmlToText(parts.join("\n\n"));
}

export const talent500Adapter: AtsAdapter = {
  provider: "talent500",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // Boxed cursor state: fetchPage closes over it because paginate() only
    // hands us (offset, page) and the server ignores the offset entirely.
    let cursor: ReadonlyArray<number | string> | null = null;
    return paginate<NormalizedPosting>({
      provider: "talent500",
      company: company.slug,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      // Safety net: if the vendor ever stops returning search_after we fall
      // back to the (ignored) offset walk, and the exact-repeat stall check
      // ends pagination honestly instead of double-counting page 1.
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, page) => {
        const raw = await atsFetchJson(talent500ListUrl(company.slug, offset, PAGE_SIZE, cursor), { provider: "talent500" });
        const parsed = parseOrThrow(TalentListSchema, raw, {
          provider: "talent500",
          slug: company.slug,
          what: `list (offset ${offset})`,
        });
        // Dead-tenant checks, page 1 only: once page 1 has proven the filter is
        // being applied, the tenant exists, and no later page can revoke that.
        // Keeping them off pages 2+ also means a board that produced postings
        // can never be failed by a hiccup deep in the crawl.
        if (page === 0) {
          if (talent500FilterWasIgnored(parsed.data, company.slug)) {
            throw new Error(
              `talent500: tenant does not exist at ${talent500ListUrl(company.slug, 0)} — the server ` +
                `ignored company_slug and returned ${parsed.total ?? parsed.data.length} postings belonging to ` +
                `other employers (${[...new Set(parsed.data.map((j) => j.company?.slug))].slice(0, 3).join(", ")}). ` +
                `Slug "${company.slug}" is dead, not the board empty.`,
            );
          }
          // Zero rows is the ONE shape a dead slug has never produced, so it
          // normally means a real board with nothing open (ciena, zinnia, aveva,
          // alfa-laval, vip-india and csgi all sat at total=0 on 2026-08-02).
          // Confirm against the company profile anyway, so the day the vendor
          // starts answering an unknown slug with an honest empty page we fail
          // instead of going quietly green.
          if (parsed.data.length === 0) await assertTalent500TenantExists(company.slug);
        }
        cursor = parsed.search_after ?? null;
        const items = parsed.data
          .filter(talent500ShouldKeep)
          .map((j) => normalizeTalent500Job(company, j));
        // Advance by the raw record count, not the filtered count, so
        // closed/undisplayable rows dropped above don't shorten the page and
        // cause the next page to be fetched at the wrong offset.
        return { items, total: parsed.total ?? null, rawCount: parsed.data.length };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const jobSlug = talent500SlugFromUrl(posting.jobUrl);
    const raw = await atsFetchJson(talent500DetailUrl(jobSlug), { provider: "talent500" });
    const parsed = parseOrThrow(TalentDetailSchema, raw, { provider: "talent500", slug: jobSlug, what: "detail" });
    return buildTalent500Jd(parsed);
  },
};
