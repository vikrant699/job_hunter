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
// Response: { count, num_pages, next, host, results: [...] }, 20/page. Each
// result carries the full JD inline as `requistion_description` (HTML, note
// the vendor's spelling) with `public_job_desc` (plain text) as a fallback —
// one-phase, no fetchJd needed.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJsonMultipart } from "./http.js";
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

export function normalizeCeipal(company: AdapterCompany, j: CeipalJob): NormalizedPosting {
  const location = ceipalLocation(j);
  const title = (j.position_title && j.position_title.trim()) || j.public_job_title || "";
  const jd = j.requistion_description ?? j.public_job_desc ?? "";
  const remoteFlag = j.remote_opportunities === 1 || j.remote_opportunities === "1";
  return {
    provider: "ceipal",
    externalId: String(j.job_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: j.campus_portal_job_details_url ?? `${company.careersUrl}?job=${j.job_id}`,
    location,
    isRemote: remoteFlag || (location ? REMOTE_RE.test(location) : false),
    jdText: htmlToText(jd),
    postedAt: parseCeipalDate(j.created),
  };
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
        const parsed = PageSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "ceipal list schema mismatch");
          throw new Error(`ceipal list failed schema for ${company.slug}`);
        }
        return {
          items: parsed.data.results.map((j) => normalizeCeipal(company, j)),
          total: parsed.data.count ?? null,
        };
      },
    });
  },
  // requistion_description / public_job_desc are inline in the list response — no fetchJd.
};
