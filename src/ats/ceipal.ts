// src/ats/ceipal.ts — Ceipal ATS "CareerPortal" JSON API.
// POST careerapi.ceipal.com/<api_key>/CareerPortalJobPostings/?page=<n>, multipart/form-data; Referer header is
// REQUIRED or it 400s as bot access. api_key + cp_id are per-tenant widget-embed attributes with no host/path to
// regex-match, so (like Keka/Eightfold) apiMeta must supply them out of band.
// JD is two-phase: the list truncates description to a ~184-char teaser. Full JD is a separate unauthenticated GET
// on candidateportal.ceipal.com/api/jobs/description/<token> (token = last segment of campus_portal_job_details_url);
// jdText is left empty so the pipeline calls fetchJd, falling back to the teaser only if that call fails.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchJsonMultipart, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, joinLocation } from "./shared.js";

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

/** `multpile_job_location` (vendor's typo'd field) arrives pre-formatted, e.g. "(Bengaluru, KA, 560001)" - strip parens. */
export function ceipalLocation(j: CeipalJob): string | null {
  const bracketed = j.multpile_job_location?.trim();
  if (bracketed) return bracketed.replace(/^\(/, "").replace(/\)$/, "");
  return joinLocation(j.city, j.state, j.country);
}

// Falls back to public_job_desc when requistion_description is absent OR empty (some jobs return "" for it with
// content in the other field, so a plain `??` would wrongly yield the empty string).
export function ceipalTeaser(j: CeipalJob): string {
  const req = j.requistion_description?.trim();
  const raw = req || j.public_job_desc || "";
  return htmlToText(raw);
}

const DETAIL_TOKEN_RE = /\/job-details\/([^/?#]+)/;

/** Null when jobUrl is the constructed careers fallback (no detail URL in the listing). */
export function ceipalDetailToken(jobUrl: string): string | null {
  const m = DETAIL_TOKEN_RE.exec(jobUrl);
  return m ? (m[1] ?? null) : null;
}

export function ceipalDescriptionUrl(token: string): string {
  return `https://candidateportal.ceipal.com/api/jobs/description/${encodeURIComponent(token)}`;
}

// The pipeline only calls fetchJd when jdText is empty, so the teaser is stashed here keyed by the posting object
// it passes back into fetchJd.
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
    jdText: "", // full JD comes from fetchJd; teaser kept as a fallback via the WeakMap
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
