// list: GET /api/v1/career/jobs?page=&per_page= -> {jobs[]} (only a short_description teaser, not the full JD)
// jd: GET /api/v1/career/jobs/<numeric id> (keyed by numeric id, NOT the slug - the slug path 404s)
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

const API_ORIGIN = "https://app.advantageclub.ai";
const PUBLIC_ORIGIN = "https://www.advantageclub.ai";
const PAGE_SIZE = 50;
const MAX_PAGES = 5000; // runaway backstop only, never truncate

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

export function advantageClubListUrl(page: number, perPage: number = PAGE_SIZE): string {
  return `${API_ORIGIN}/api/v1/career/jobs?page=${page}&per_page=${perPage}`;
}

export function advantageClubDetailUrl(id: number): string {
  return `${API_ORIGIN}/api/v1/career/jobs/${id}`;
}

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
