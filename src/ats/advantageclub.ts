// src/ats/advantageclub.ts — Advantage Club's own careers board (a single
// company, not a shared-vendor aggregator — Advantage Club is itself the
// employer here, not one of many tenants on someone else's platform).
//
//   list:   GET https://app.advantageclub.ai/api/v1/career/jobs
//                ?page=<1-based N>&per_page=<SIZE>
//           -> { success: true, jobs: [ <job>, ... ],
//                meta: { current_page, total_pages, total_count } }
//           No auth. Confirmed live 2026-07-15 (curl): page=1&per_page=50
//           returned all 5 open India roles in one page; page=2 returned an
//           empty `jobs: []` with the same meta — pagination terminates on
//           either an empty page or offset >= meta.total_count.
//
//   The list item only carries a `short_description` (a 1-2 sentence
//   summary), NOT the full JD — confirmed by inspecting a raw list response.
//
//   detail: GET https://app.advantageclub.ai/api/v1/career/jobs/<numeric id>
//           -> { success: true, job: { id, slug, title, category, location,
//                description, responsibilities, skills_required,
//                experience_qualification, education_qualification,
//                experience_required, short_description, remote_policy,
//                salary_range, no_of_vacancy, job_type, deadline_date,
//                published_at } }
//           Confirmed live: GET .../api/v1/career/jobs/17 returns the full
//           `description` / `responsibilities` / `experience_qualification`
//           text for that role (200); a made-up id (e.g. 999999) 404s.
//           NOTE: this is keyed by the job's numeric `id`, NOT its `slug` —
//           GET .../api/v1/career/jobs/op1 (the slug) 404s (returns the
//           site's generic 404 HTML page, not JSON).
//
//   public job URL: the marketing site's careers page
//   (https://www.advantageclub.ai/pages/ac_career) client-fetches the same
//   list endpoint and links each row to
//   /pages/ac_career/vacancy_details/<id> — recovered from that page's Next.js
//   chunk (.../pages/ac_career/page-*.js), which contains the literal
//   template string `href:"/pages/ac_career/vacancy_details/".concat(e.id)`.
//   Confirmed live: GET .../pages/ac_career/vacancy_details/17 (200) renders
//   that job's title. Built from the numeric id, same as the detail endpoint.
//
// JD: the detail endpoint above does return a full JD, so fetchJd builds it
//   by concatenating, in order, whichever of [description, responsibilities,
//   skills_required, experience_qualification, education_qualification,
//   short_description] are present and non-empty, then stripping HTML (the
//   fields are plain text with literal bullets/CRLFs in practice, not HTML,
//   but htmlToText is a harmless no-op on plain text and normalizes
//   whitespace). short_description is included last purely as a safety net
//   in case a future posting is missing every other field.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const API_ORIGIN = "https://app.advantageclub.ai";
const PUBLIC_ORIGIN = "https://www.advantageclub.ai";
const PAGE_SIZE = 50;
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

const AdvantageClubJobSchema = z.object({
  id: z.number(),
  slug: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  remote_policy: z.string().nullable().optional(),
  short_description: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
});
export type AdvantageClubJob = z.infer<typeof AdvantageClubJobSchema>;

const AdvantageClubMetaSchema = z.object({
  current_page: z.number().nullable().optional(),
  total_pages: z.number().nullable().optional(),
  total_count: z.number().nullable().optional(),
});

const AdvantageClubListSchema = z.object({
  success: z.boolean(),
  jobs: z.array(AdvantageClubJobSchema),
  meta: AdvantageClubMetaSchema.nullable().optional(),
});

const AdvantageClubDetailSchema = z.object({
  success: z.boolean(),
  job: z.object({
    id: z.number(),
    description: z.string().nullable().optional(),
    responsibilities: z.string().nullable().optional(),
    skills_required: z.string().nullable().optional(),
    experience_qualification: z.string().nullable().optional(),
    education_qualification: z.string().nullable().optional(),
    short_description: z.string().nullable().optional(),
  }),
});
export type AdvantageClubDetail = z.infer<typeof AdvantageClubDetailSchema>["job"];

/** Build the paged list URL (1-based `page`, per the live API). */
export function advantageClubListUrl(page: number, perPage: number = PAGE_SIZE): string {
  return `${API_ORIGIN}/api/v1/career/jobs?page=${page}&per_page=${perPage}`;
}

/** Build the job-detail URL from a job's numeric id (NOT its `slug`). */
export function advantageClubDetailUrl(id: number): string {
  return `${API_ORIGIN}/api/v1/career/jobs/${id}`;
}

/** Public job page URL, built from the same numeric id. */
export function advantageClubJobUrl(id: number): string {
  return `${PUBLIC_ORIGIN}/pages/ac_career/vacancy_details/${id}`;
}

export function normalizeAdvantageClubJob(company: AdapterCompany, j: AdvantageClubJob): NormalizedPosting {
  const location = j.location ?? null;
  return {
    provider: "advantageclub",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: (j.title && j.title.trim()) || "",
    jobUrl: advantageClubJobUrl(j.id),
    location,
    isRemote: (j.remote_policy ?? "").trim().toLowerCase() === "remote" || REMOTE_RE.test(location ?? ""),
    jdText: "",
    postedAt: dateToIso(j.published_at),
  };
}

/** Build the plain-text JD by concatenating, in order, whichever of
 *  [description, responsibilities, skills_required, experience_qualification,
 *  education_qualification, short_description] are present and non-empty,
 *  then stripping HTML. Throws if none yield text. */
export function buildAdvantageClubJd(detail: AdvantageClubDetail): string {
  const parts = [
    detail.description,
    detail.responsibilities,
    detail.skills_required,
    detail.experience_qualification,
    detail.education_qualification,
    detail.short_description,
  ].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (parts.length === 0) throw new Error("advantageclub: job detail had no JD-bearing fields");
  return htmlToText(parts.join("\n\n"));
}

export const advantageclubAdapter: AtsAdapter = {
  provider: "advantageclub",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await paginate<AdvantageClubJob>({
      provider: "advantageclub",
      company: company.slug,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(advantageClubListUrl(page + 1, PAGE_SIZE), { provider: "advantageclub" });
        const parsed = parseOrThrow(AdvantageClubListSchema, json, {
          provider: "advantageclub",
          slug: company.slug,
          what: `list p${page + 1}`,
        });
        return {
          items: parsed.jobs,
          total: parsed.meta?.total_count ?? null,
        };
      },
    });
    return raw.map((j) => normalizeAdvantageClubJob(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const id = Number(posting.externalId);
    const raw = await atsFetchJson(advantageClubDetailUrl(id), { provider: "advantageclub" });
    const parsed = parseOrThrow(AdvantageClubDetailSchema, raw, {
      provider: "advantageclub",
      slug: posting.externalId,
      what: "detail",
    });
    return buildAdvantageClubJd(parsed.job);
  },
};
