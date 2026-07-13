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
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const API_ORIGIN = "https://prod-warmachine.talent500.co";
const PUBLIC_JOB_ORIGIN = "https://talent500.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

const TalentCountrySchema = z.object({
  name: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
});

const TalentJobSchema = z.object({
  id: z.string(),
  title_alias_1: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  slug: z.string(),
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

/** Build the paged list-search URL for one company. */
export function talent500ListUrl(companySlug: string, offset: number, size: number = PAGE_SIZE): string {
  return `${API_ORIGIN}/api/v3/jobs/search/?company_slug=${encodeURIComponent(companySlug)}&offset=${offset}&size=${size}`;
}

/** Build the job-detail URL from a job's slug (NOT its uuid `id`). */
export function talent500DetailUrl(jobSlug: string): string {
  return `${API_ORIGIN}/api/jobs/${encodeURIComponent(jobSlug)}/`;
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

/** created_at ("2026-06-24T14:51:54.811468+05:30") -> plain ISO, or null if
 *  absent/unparseable. (`posted_on` is a relative string like "19 days ago"
 *  and is intentionally never used.) */
function parseTalent500PostedAt(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
    postedAt: parseTalent500PostedAt(j.created_at),
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
    return paginate<NormalizedPosting>({
      provider: "talent500",
      company: company.slug,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      fetchPage: async (offset) => {
        const raw = await atsFetchJson(talent500ListUrl(company.slug, offset), { provider: "talent500" });
        const parsed = TalentListSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { slug: company.slug, offset, issues: parsed.error.issues.slice(0, 2) },
            "talent500 list schema mismatch",
          );
          throw new Error(`talent500 list response failed schema for ${company.slug}`);
        }
        const items = parsed.data.data
          .filter(talent500ShouldKeep)
          .map((j) => normalizeTalent500Job(company, j));
        // Advance by the raw record count, not the filtered count, so
        // closed/undisplayable rows dropped above don't shorten the page and
        // cause the next page to be fetched at the wrong offset.
        return { items, total: parsed.data.total ?? null, rawCount: parsed.data.data.length };
      },
    });
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const jobSlug = talent500SlugFromUrl(posting.jobUrl);
    const raw = await atsFetchJson(talent500DetailUrl(jobSlug), { provider: "talent500" });
    const parsed = TalentDetailSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`talent500: job detail failed schema for slug "${jobSlug}"`);
    }
    return buildTalent500Jd(parsed.data);
  },
};
