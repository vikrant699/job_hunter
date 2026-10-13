// List: GET prod-warmachine.talent500.co/api/v3/jobs/search/?company_slug=<slug>&size=<N>, paged by the response's search_after cursor. Detail: GET .../api/jobs/<job.slug>/.
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
const MAX_PAGES = 5000;

const TalentCountrySchema = z.object({
  name: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
});

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
  // The server ignores `offset` (every value re-serves page 1); the search_after cursor is the only real pagination.
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

export function talent500ListUrl(
  companySlug: string,
  offset: number,
  size: number = PAGE_SIZE,
  searchAfter: ReadonlyArray<number | string> | null = null,
): string {
  const base = `${API_ORIGIN}/api/v3/jobs/search/?company_slug=${encodeURIComponent(companySlug)}&offset=${offset}&size=${size}`;
  return searchAfter === null ? base : `${base}&search_after=${encodeURIComponent(JSON.stringify(searchAfter))}`;
}

// Detail URL uses the job's slug, NOT its uuid `id`.
export function talent500DetailUrl(jobSlug: string): string {
  return `${API_ORIGIN}/api/jobs/${encodeURIComponent(jobSlug)}/`;
}

// Company-profile endpoint, used solely as an existence oracle.
export function talent500CompanyUrl(companySlug: string): string {
  return `${API_ORIGIN}/api/companies/${encodeURIComponent(companySlug)}/`;
}

// An unknown slug 200s with the whole aggregator instead of rejecting, so require a returned row to belong to this company.
export function talent500FilterWasIgnored(rows: readonly Talent500Job[], companySlug: string): boolean {
  const rowSlugs = rows.map((r) => r.company?.slug).filter((s): s is string => typeof s === "string" && s !== "");
  if (rowSlugs.length === 0) return false;
  return !rowSlugs.includes(companySlug);
}

// Throw only on a definitive 404; a 400 "Not Published" means a healthy company with no public profile.
export async function assertTalent500TenantExists(companySlug: string): Promise<void> {
  const url = talent500CompanyUrl(companySlug);
  let status: number;
  try {
    // Raw fetch: atsFetchJson throws before the status can be read.
    const res = await withAtsTimeout((signal) =>
      fetch(url, { headers: { "User-Agent": config.fetch.userAgent, Accept: "application/json" }, signal }),
    );
    status = res.status;
  } catch {
    return;
  }
  if (status === 404) {
    throw new Error(
      `talent500: tenant does not exist at ${url} — the company profile is absent, and the list ` +
        `endpoint answers an unknown company_slug with the whole unfiltered aggregator feed rather ` +
        `than an empty board. Slug "${companySlug}" is dead, not the board empty.`,
    );
  }
}

export function talent500JobUrl(jobSlug: string): string {
  return `${PUBLIC_JOB_ORIGIN}/jobs/${jobSlug}`;
}

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
    // created_at is the only reliable timestamp; posted_on ("19 days ago") is never used.
    postedAt: dateToIso(j.created_at),
  };
}

export function talent500SlugFromUrl(jobUrl: string): string {
  const parts = new URL(jobUrl).pathname.split("/").filter(Boolean);
  const slug = parts[parts.length - 1];
  if (!slug) throw new Error(`talent500: could not derive job slug from jobUrl "${jobUrl}"`);
  return slug;
}

export function buildTalent500Jd(detail: Talent500Detail): string {
  const parts = [detail.role_summary, detail.description, detail.responsibilities, detail.what_you_need_to_succeed]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "");
  if (parts.length === 0) throw new Error("talent500: job detail had no JD-bearing fields");
  return htmlToText(parts.join("\n\n"));
}

export const talent500Adapter: AtsAdapter = {
  provider: "talent500",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    let cursor: ReadonlyArray<number | string> | null = null;
    return paginate<NormalizedPosting>({
      provider: "talent500",
      company: company.slug,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      dedupeBy: (p) => p.externalId,
      fetchPage: async (offset, page) => {
        const raw = await atsFetchJson(talent500ListUrl(company.slug, offset, PAGE_SIZE, cursor), { provider: "talent500" });
        const parsed = parseOrThrow(TalentListSchema, raw, {
          provider: "talent500",
          slug: company.slug,
          what: `list (offset ${offset})`,
        });
        if (page === 0) {
          if (talent500FilterWasIgnored(parsed.data, company.slug)) {
            throw new Error(
              `talent500: tenant does not exist at ${talent500ListUrl(company.slug, 0)} — the server ` +
                `ignored company_slug and returned ${parsed.total ?? parsed.data.length} postings belonging to ` +
                `other employers (${[...new Set(parsed.data.map((j) => j.company?.slug))].slice(0, 3).join(", ")}). ` +
                `Slug "${company.slug}" is dead, not the board empty.`,
            );
          }
          if (parsed.data.length === 0) await assertTalent500TenantExists(company.slug);
        }
        cursor = parsed.search_after ?? null;
        const items = parsed.data
          .filter(talent500ShouldKeep)
          .map((j) => normalizeTalent500Job(company, j));
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
