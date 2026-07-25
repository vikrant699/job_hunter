// src/ats/ceipal.ts — Ceipal ATS "CareerPortal" JSON API.
//
//   POST https://careerapi.ceipal.com/<api_key>/CareerPortalJobPostings/?page=<n>
//   multipart/form-data: page, api_key, method=CareerPortalJobPostings, cp_id,
//   from_career_portal=1
//   Header `Referer: https://jobsapi.ceipal.com/` is REQUIRED — omitting it
//   (or a plain JSON body) 400s with "not allowed from outside the Career
//   Portal" / "Bot access is not allowed".
//
// api_key + cp_id are per-tenant, embedded as `data-ceipal-api-key` /
// `data-ceipal-career-portal-id` attributes on the widget <script> tag the
// company embeds on its own careers page (widget.js at jobsapi.ceipal.com) —
// there's no per-tenant host/path to regex-match the way Keka's
// `<slug>.keka.com/careers` is, so like Keka/Eightfold this adapter requires
// apiMeta (api_key, cp_id) supplied out of band; it can't be auto-discovered
// from a bare careers URL.
//
// Response: { count, num_pages, next, host, results: [...] }, 20/page.
//
// JD — TWO-PHASE, fetchJd IS required. The list endpoint TRUNCATES both
// `requistion_description` and `public_job_desc` to a ~184-char teaser (cut
// mid-word, uniform across jobs) — it is NOT the full JD. The complete
// description lives behind a separate, unauthenticated GET on the candidate
// portal that backs each job's detail page:
//
//   GET https://candidateportal.ceipal.com/api/jobs/description/<token>
//   -> { status, data: { jobInfo: { descriptionData: { jobDescription } } } }
//
// where <token> is the last path segment of `campus_portal_job_details_url`
// (…/job-details/<token>). Confirmed live (2026-07-09): full JD 2407 chars vs
// the 184-char list teaser for Simplilearn job_id=48; no Referer/UA gating on
// the detail call. So the list leaves jdText empty (forcing the pipeline to
// call fetchJd), which fetches the full JD; the 184-char teaser is kept only
// as a per-posting fallback if that detail fetch fails.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, atsFetchJsonMultipart, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const REFERER = "https://jobsapi.ceipal.com/";
const PAGE_SIZE = 20; // server-fixed page size, confirmed live

export const CeipalJobSchema = z.object({
  job_id: z.union([z.number(), z.string()]),
  position_title: z.string().nullable().optional(),
  public_job_title: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  multpile_job_location: z.string().nullable().optional(),
  remote_opportunities: z.union([z.number(), z.string()]).nullable().optional(),
  requistion_description: z.string().nullable().optional(),
  public_job_desc: z.string().nullable().optional(),
  created: z.string().nullable().optional(),
  campus_portal_job_details_url: z.string().nullable().optional(),
});
export type CeipalJob = z.infer<typeof CeipalJobSchema>;

const PageSchema = z.object({
  count: z.number().nullable().optional(),
  num_pages: z.number().nullable().optional(),
  results: z.array(CeipalJobSchema),
});

/** The candidate-portal job-description response — only the JD body matters. */
const DetailSchema = z.object({
  data: z
    .object({
      jobInfo: z
        .object({
          descriptionData: z
            .object({ jobDescription: z.string().nullable().optional() })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export interface CeipalTokens {
  apiKey: string;
  cpId: string;
}

/** Per-tenant tokens, supplied out of band in apiMeta (see module doc). */
export function ceipalTokens(company: AdapterCompany): CeipalTokens {
  const apiKey = company.apiMeta?.api_key;
  const cpId = company.apiMeta?.cp_id;
  if (!apiKey || !cpId) {
    throw new Error(`ceipal adapter requires apiMeta.api_key and apiMeta.cp_id for ${company.slug}`);
  }
  return { apiKey, cpId };
}

export function ceipalListUrl(apiKey: string, page: number): string {
  return `https://careerapi.ceipal.com/${encodeURIComponent(apiKey)}/CareerPortalJobPostings/?page=${page}`;
}

const CEIPAL_DATE_RE = /^(\d{1,2})\/([A-Za-z]+)\/(\d{4})$/;

/** Ceipal's `created`/`modified` dates come as "30/March/2026" — parse to ISO, else null. */
export function parseCeipalDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = CEIPAL_DATE_RE.exec(s.trim());
  if (!m) return null;
  const [, day, month, year] = m;
  const ms = Date.parse(`${day} ${month} ${year}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * `multpile_job_location` (vendor's field name, and its typo) already arrives
 * pre-formatted as e.g. "(Bengaluru, KA, 560001)" — strip the parens. Falls
 * back to composing city/state/country when it's absent.
 */
export function ceipalLocation(j: CeipalJob): string | null {
  const bracketed = j.multpile_job_location?.trim();
  if (bracketed) return bracketed.replace(/^\(/, "").replace(/\)$/, "");
  const parts = [j.city, j.state, j.country].map((s) => (s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The list's ~184-char JD teaser as plain text. Prefers `requistion_description`
 * (HTML, note the vendor's spelling) but falls back to `public_job_desc` when
 * it's absent OR empty — the API returns `requistion_description: ""` for some
 * jobs whose `public_job_desc` has content, so a plain `??` (which only skips
 * null/undefined) would wrongly yield the empty string. Used only as a fallback
 * in fetchJd; the real JD comes from the detail endpoint.
 */
export function ceipalTeaser(j: CeipalJob): string {
  const req = j.requistion_description?.trim();
  const raw = req || j.public_job_desc || "";
  return htmlToText(raw);
}

const DETAIL_TOKEN_RE = /\/job-details\/([^/?#]+)/;

/**
 * The candidate-portal token that keys the full-JD endpoint — the last path
 * segment of a `…/job-details/<token>` URL. Null when the posting's jobUrl is
 * the constructed careers fallback (no detail URL was present in the listing).
 */
export function ceipalDetailToken(jobUrl: string): string | null {
  const m = DETAIL_TOKEN_RE.exec(jobUrl);
  return m ? (m[1] ?? null) : null;
}

/** Full-JD endpoint URL for a candidate-portal job-details token. */
export function ceipalDescriptionUrl(token: string): string {
  return `https://candidateportal.ceipal.com/api/jobs/description/${encodeURIComponent(token)}`;
}

/**
 * Carries the list teaser to fetchJd as a fallback. The posting must arrive at
 * the gate with the FULL JD, but the pipeline only calls fetchJd when jdText is
 * empty — so normalizeCeipal leaves jdText empty and stashes the teaser here,
 * keyed by the (identity-stable, un-cloned) posting object the pipeline passes
 * straight back into fetchJd.
 */
const teaserByPosting = new WeakMap<NormalizedPosting, string>();

export function normalizeCeipal(company: AdapterCompany, j: CeipalJob): NormalizedPosting {
  const location = ceipalLocation(j);
  const title = (j.position_title && j.position_title.trim()) || j.public_job_title || "";
  const remoteFlag = j.remote_opportunities === 1 || j.remote_opportunities === "1";
  const posting: NormalizedPosting = {
    provider: "ceipal",
    externalId: String(j.job_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: j.campus_portal_job_details_url ?? `${company.careersUrl}?job=${j.job_id}`,
    location,
    isRemote: remoteFlag || (location ? REMOTE_RE.test(location) : false),
    // Left empty on purpose so the pipeline calls fetchJd for the full JD; the
    // list only carries a ~184-char teaser (kept as a fallback via the WeakMap).
    jdText: "",
    postedAt: parseCeipalDate(j.created),
  };
  teaserByPosting.set(posting, ceipalTeaser(j));
  return posting;
}

export const ceipalAdapter: AtsAdapter = {
  provider: "ceipal",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const { apiKey, cpId } = ceipalTokens(company);
    return paginate<NormalizedPosting>({
      provider: "ceipal",
      company: company.slug,
      pageSize: PAGE_SIZE,
      fetchPage: async (_offset, page) => {
        const pageNum = page + 1;
        const raw = await atsFetchJsonMultipart(ceipalListUrl(apiKey, pageNum), {
          provider: "ceipal",
          headers: { Referer: REFERER },
          fields: {
            page: String(pageNum),
            api_key: apiKey,
            method: "CareerPortalJobPostings",
            cp_id: cpId,
            from_career_portal: "1",
          },
        });
        const parsed = parseOrThrow(PageSchema, raw, { provider: "ceipal", slug: company.slug });
        return {
          items: parsed.results.map((j) => normalizeCeipal(company, j)),
          total: parsed.count ?? null,
        };
      },
    });
  },

  // The list JD is a ~184-char teaser; fetch the full description from the
  // candidate-portal detail endpoint, falling back to the teaser only if that
  // call fails or yields nothing (never silently ship the truncated stub as if
  // it were complete).
  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const teaser = teaserByPosting.get(posting) ?? "";
    const token = ceipalDetailToken(posting.jobUrl);
    if (!token) {
      logger.debug({ externalId: posting.externalId, jobUrl: posting.jobUrl }, "ceipal: no job-details token, using teaser");
      return teaser;
    }
    try {
      const raw = await atsFetchJson(ceipalDescriptionUrl(token), { provider: "ceipal" });
      const parsed = DetailSchema.safeParse(raw);
      const jd = parsed.success ? htmlToText(parsed.data.data?.jobInfo?.descriptionData?.jobDescription ?? "") : "";
      return jd || teaser;
    } catch (err) {
      logger.warn({ externalId: posting.externalId, err: String(err) }, "ceipal detail fetch failed; using teaser");
      return teaser;
    }
  },
};
