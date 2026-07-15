// src/ats/nineninegames.ts — 99Games' careers board, a single-tenant custom
// CMS ("BackendCms") API — not a multi-company ATS platform.
//
// The public careers page (https://www.99games.in/careers, aka
// 99games.in/careers.html) is a static page whose "current openings" tab is
// populated client-side (resources/js/careers/script.js's `getJobs`) by an
// unauthenticated GET against the CMS backend:
//
//   GET https://blogbackend.99games.in/BackendCms/jobOpportunities/opportunities
//   -> a bare JSON array of job objects (no envelope, no pagination — the
//      client itself requests the whole list in one shot and renders every
//      row into tab-scoped card containers client-side).
//
// Confirmed live 2026-07: no auth/params needed, description is full HTML
// inline on every row, so this is a one-phase adapter (no fetchJd).
//
// Related endpoints exist (`jobTypes/job-types` for the category tab list,
// `opportunitiesByType/<type>` for a category-filtered subset of the same
// rows) but are redundant with the main list above — not used here.
//
// There is no per-job public URL: the careers page opens an in-page modal
// (`.apply-now` click handler indexes into the in-memory `jobs` array) rather
// than navigating anywhere, and `jobApply` posts `appliedJob: job._id` as the
// only job reference. `jobUrl` is therefore synthesized as the careers page
// URL plus a `#job-<id>` fragment (mirrors src/ats/onecard.ts's same-shaped
// modal board) — stable and unique per posting, even though the fragment
// isn't a real anchor the page listens for.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const API_URL = "https://blogbackend.99games.in/BackendCms/jobOpportunities/opportunities";

export const NineNineGamesJobSchema = z.object({
  _id: z.string(),
  jobTitle: z.string(),
  jobLocation: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  publish: z.boolean().nullable().optional(),
  last_modified_on: z.string().nullable().optional(),
});
export type NineNineGamesJob = z.infer<typeof NineNineGamesJobSchema>;

const NineNineGamesListSchema = z.array(NineNineGamesJobSchema);

/** Keep a job unless the CMS has explicitly unpublished it. */
export function nineNineGamesShouldKeep(j: NineNineGamesJob): boolean {
  return j.publish !== false;
}

/** Synthesized per-job URL: the careers page plus a `#job-<id>` fragment —
 *  see module header for why there is no real per-job page. */
export function nineNineGamesJobUrl(company: AdapterCompany, id: string): string {
  return `${company.careersUrl.replace(/\/+$/, "")}#job-${id}`;
}

/** `last_modified_on` ("2026-01-13T05:45:39.000Z") -> plain ISO, or null if
 *  absent/unparseable. This is a last-*modified* stamp, not a created/posted
 *  one — the API exposes nothing better, so it's the closest available proxy
 *  for postedAt. */
function parseNineNineGamesModifiedAt(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function normalizeNineNineGamesJob(company: AdapterCompany, j: NineNineGamesJob): NormalizedPosting {
  const location = j.jobLocation ?? null;
  return {
    provider: "nineninegames",
    externalId: j._id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle.trim(),
    jobUrl: nineNineGamesJobUrl(company, j._id),
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: htmlToText(j.description),
    postedAt: parseNineNineGamesModifiedAt(j.last_modified_on),
  };
}

export const nineNineGamesAdapter: AtsAdapter = {
  provider: "nineninegames",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(API_URL, { provider: "nineninegames" });
    const parsed = NineNineGamesListSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { slug: company.slug, issues: parsed.error.issues.slice(0, 2) },
        "nineninegames list schema mismatch",
      );
      throw new Error(`nineninegames list response failed schema for ${company.slug}`);
    }
    return parsed.data
      .filter(nineNineGamesShouldKeep)
      .map((j) => normalizeNineNineGamesJob(company, j));
  },
};
