// list: POST careerapi.ceipal.com/<api_key>/CareerPortalJobPostings/?page=<n>, multipart/form-data, Referer required or 400s as bot access; api_key+cp_id come from apiMeta (per-tenant widget-embed attrs, no host/path to regex-match)
// jd: GET careerapi.ceipal.com/<api_key>/CareerPortalJobPostings/<id>/?from_career_portal=1&cp_id=<cp_id> (same Referer); list public_job_desc is only a teaser
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, atsFetchJsonMultipart, parseOrNull, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, joinLocation } from "./shared.js";

const REFERER = "https://jobsapi.ceipal.com/";
const PAGE_SIZE = 20; // server-fixed page size, confirmed live

export const CeipalJobSchema = z.object({
  id: z.string().min(1),
  public_job_title: z.string().nullable().optional(),
  public_job_desc: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  multpile_job_location: z.string().nullable().optional(),
  remote_opportunities: z.union([z.number(), z.string()]).nullable().optional(),
});
export type CeipalJob = z.infer<typeof CeipalJobSchema>;

const PageSchema = z.object({
  count: z.number().nullable().optional(),
  num_pages: z.number().nullable().optional(),
  results: z.array(CeipalJobSchema),
});

const DetailSchema = z.object({ public_job_desc: z.string().nullable().optional() });

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

export function ceipalDetailUrl(t: CeipalTokens, id: string): string {
  return `https://careerapi.ceipal.com/${encodeURIComponent(t.apiKey)}/CareerPortalJobPostings/${encodeURIComponent(id)}/?from_career_portal=1&cp_id=${encodeURIComponent(t.cpId)}`;
}

export function ceipalJobUrl(t: CeipalTokens, id: string): string {
  const q = new URLSearchParams({ api_key: t.apiKey, cp_id: t.cpId, job_id: id });
  return `https://jobsapi.ceipal.com/APISource/v1/index.html?${q.toString()}`;
}

/** `multpile_job_location` (vendor's typo'd field) arrives pre-formatted, e.g. "(Bengaluru, KA, 560001)" - strip parens. */
export function ceipalLocation(j: CeipalJob): string | null {
  const bracketed = j.multpile_job_location?.trim();
  if (bracketed) return bracketed.replace(/^\(/, "").replace(/\)$/, "");
  return joinLocation(j.city, j.state, j.country);
}

export function ceipalTeaser(j: CeipalJob): string {
  return htmlToText(j.public_job_desc ?? "");
}

// Stashed here keyed by the posting object, since fetchJd only receives the posting back (not this teaser).
const teaserByPosting = new WeakMap<NormalizedPosting, string>();

export function normalizeCeipal(company: AdapterCompany, t: CeipalTokens, j: CeipalJob): NormalizedPosting {
  const location = ceipalLocation(j);
  const remoteFlag = j.remote_opportunities === 1 || j.remote_opportunities === "1";
  const posting: NormalizedPosting = {
    provider: "ceipal",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.public_job_title?.trim() ?? "",
    jobUrl: ceipalJobUrl(t, j.id),
    location,
    isRemote: remoteFlag || (location ? REMOTE_RE.test(location) : false),
    jdText: "", // full JD comes from fetchJd; teaser kept as a fallback via the WeakMap
    postedAt: null, // list only carries a relative "2 weeks ago"
  };
  teaserByPosting.set(posting, ceipalTeaser(j));
  return posting;
}

export const ceipalAdapter: AtsAdapter = {
  provider: "ceipal",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const tokens = ceipalTokens(company);
    return paginate<NormalizedPosting>({
      provider: "ceipal",
      company: company.slug,
      pageSize: PAGE_SIZE,
      fetchPage: async (_offset, page) => {
        const pageNum = page + 1;
        const raw = await atsFetchJsonMultipart(ceipalListUrl(tokens.apiKey, pageNum), {
          provider: "ceipal",
          headers: { Referer: REFERER },
          fields: {
            page: String(pageNum),
            api_key: tokens.apiKey,
            method: "CareerPortalJobPostings",
            cp_id: tokens.cpId,
            from_career_portal: "1",
          },
        });
        const parsed = parseOrThrow(PageSchema, raw, { provider: "ceipal", slug: company.slug });
        return {
          items: parsed.results.map((j) => normalizeCeipal(company, tokens, j)),
          total: parsed.count ?? null,
        };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const teaser = teaserByPosting.get(posting) ?? "";
    try {
      const raw = await atsFetchJson(ceipalDetailUrl(ceipalTokens(company), posting.externalId), {
        provider: "ceipal",
        headers: { Referer: REFERER },
      });
      const parsed = parseOrNull(DetailSchema, raw, { provider: "ceipal", slug: company.slug });
      return htmlToText(parsed?.public_job_desc ?? "") || teaser;
    } catch (err) {
      logger.warn({ externalId: posting.externalId, err: String(err) }, "ceipal detail fetch failed; using teaser");
      return teaser;
    }
  },
};
