// src/ats/dover.ts — Dover (app.dover.com) public career boards, e.g. Codingal, SALT.
// Every tenant lives under the SAME shared host (no per-tenant subdomain), keyed
// by an opaque client id rather than the human-readable slug. Three-call shape:
//   resolve: GET /api/v1/careers-page-slug/<slug>              -> { id, name, ... }
//   list:    GET /api/v1/careers-page/<clientId>/jobs?limit=&offset=
//            -> DRF LimitOffsetPagination { count, next, previous, results[] }
//            (no description field — two-phase, fetchJd is mandatory)
//   detail:  GET /api/v1/jobs/<jobId>/get_job_description
//            -> { user_facing_description, user_provided_description,
//                 generated_description: {about_the_role, job_mandates,
//                 qualifications, about_the_company, additional_information},
//                 external_url }
// Plain fetch works fine (no WAF in front of the JSON API; confirmed live
// against codingal/salt with the default bot UA). clientId is cached in
// apiMeta.clientId when known (set at conversion time); resolved on demand via
// the slug endpoint otherwise, so the adapter also works with apiMeta: null
// (used by ats-validate's live probe).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow, parseOrNull } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const DOVER_HOST = "https://app.dover.com";
const PAGE = 100;

const DoverLocationOptionSchema = z.object({
  display_name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

const DoverLocationSchema = z.object({
  location_type: z.string().nullable().optional(),
  location_option: DoverLocationOptionSchema.nullable().optional(),
  name: z.string().nullable().optional(),
  is_primary: z.boolean().nullable().optional(),
});
export type DoverLocation = z.infer<typeof DoverLocationSchema>;

export const DoverJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  locations: z.array(DoverLocationSchema).nullable().optional(),
  workplace_type: z.string().nullable().optional(),
  is_published: z.boolean().nullable().optional(),
  is_sample: z.boolean().nullable().optional(),
});
export type DoverJob = z.infer<typeof DoverJobSchema>;

const DoverJobsPageSchema = z.object({
  count: z.number().nullable().optional(),
  next: z.string().nullable().optional(),
  results: z.array(DoverJobSchema),
});

const CareersPageSlugSchema = z.object({ id: z.string() });

const DoverGeneratedDescriptionSchema = z.object({
  about_the_role: z.string().nullable().optional(),
  job_mandates: z.string().nullable().optional(),
  qualifications: z.string().nullable().optional(),
  about_the_company: z.string().nullable().optional(),
  additional_information: z.string().nullable().optional(),
});

const DoverJobDescriptionSchema = z.object({
  user_facing_description: z.string().nullable().optional(),
  user_provided_description: z.string().nullable().optional(),
  generated_description: DoverGeneratedDescriptionSchema.nullable().optional(),
  external_url: z.string().nullable().optional(),
});
export type DoverJobDescription = z.infer<typeof DoverJobDescriptionSchema>;

export function doverCareersPageSlugUrl(slug: string): string {
  return `${DOVER_HOST}/api/v1/careers-page-slug/${encodeURIComponent(slug)}`;
}

export function doverJobsUrl(clientId: string, offset: number, limit: number = PAGE): string {
  return `${DOVER_HOST}/api/v1/careers-page/${encodeURIComponent(clientId)}/jobs?limit=${limit}&offset=${offset}`;
}

export function doverJdUrl(jobId: string): string {
  return `${DOVER_HOST}/api/v1/jobs/${encodeURIComponent(jobId)}/get_job_description`;
}

export function doverJobUrl(slug: string, jobId: string): string {
  return `${DOVER_HOST}/apply/${encodeURIComponent(slug)}/${encodeURIComponent(jobId)}`;
}

/** Resolve the client id needed by the jobs endpoint: prefer the cached
 *  `apiMeta.clientId` (set at conversion time), else look it up live from the
 *  slug — cheap and needs no scraping, unlike e.g. Keka's org GUID. */
export async function resolveDoverClientId(company: AdapterCompany): Promise<string> {
  const cached = company.apiMeta?.clientId;
  if (cached) return cached;
  const raw = await atsFetchJson(doverCareersPageSlugUrl(company.slug), { provider: "dover" });
  const parsed = CareersPageSlugSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`dover: could not resolve client id for ${company.slug}`);
  }
  return parsed.data.id;
}

function primaryLocation(job: DoverJob): DoverLocation | null {
  const locs = job.locations ?? [];
  return locs.find((l) => l.is_primary) ?? locs[0] ?? null;
}

function locationText(job: DoverJob): string | null {
  const loc = primaryLocation(job);
  if (!loc) return null;
  return loc.name ?? loc.location_option?.display_name ?? null;
}

function isRemoteJob(job: DoverJob): boolean {
  if (job.workplace_type === "REMOTE") return true;
  if (primaryLocation(job)?.location_type === "REMOTE") return true;
  const text = locationText(job);
  return text ? REMOTE_RE.test(text) : false;
}

export function normalizeDover(company: AdapterCompany, j: DoverJob): NormalizedPosting {
  return {
    provider: "dover",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title.trim(),
    jobUrl: doverJobUrl(company.slug, j.id),
    location: locationText(j),
    isRemote: isRemoteJob(j),
    jdText: "", // two-phase — filled in by fetchJd
    postedAt: null, // not exposed by the careers-page/jobs list endpoint
  };
}

/** Pick the JD body Dover would actually render to a candidate: the finished
 *  user-facing copy if set, else the employer's raw HTML, else — for boards
 *  using Dover's AI-generated JD — assemble the structured sections. */
export function extractDoverJd(detail: DoverJobDescription): string {
  const facing = (detail.user_facing_description ?? "").trim();
  if (facing) return htmlToText(facing);

  const provided = (detail.user_provided_description ?? "").trim();
  if (provided) return htmlToText(provided);

  const g = detail.generated_description;
  if (g) {
    const sections = [g.about_the_company, g.about_the_role, g.job_mandates, g.qualifications, g.additional_information]
      .filter((s): s is string => Boolean(s && s.trim()));
    if (sections.length > 0) return htmlToText(sections.join("\n\n"));
  }

  return "";
}

export const doverAdapter: AtsAdapter = {
  provider: "dover",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const clientId = await resolveDoverClientId(company);
    return paginate<NormalizedPosting>({
      provider: "dover",
      company: company.slug,
      pageSize: PAGE,
      fetchPage: async (offset) => {
        const raw = await atsFetchJson(doverJobsUrl(clientId, offset), { provider: "dover" });
        const parsed = parseOrThrow(DoverJobsPageSchema, raw, { provider: "dover", slug: company.slug });
        // Dover shows sample/unpublished jobs to prospective employers on
        // thin boards — filter before normalizing, but advance the offset by
        // the RAW page size so filtered-out records don't skew pagination.
        const live = parsed.results.filter((j) => j.is_published !== false && !j.is_sample);
        return {
          items: live.map((j) => normalizeDover(company, j)),
          total: parsed.count ?? null,
          rawCount: parsed.results.length,
        };
      },
    });
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(doverJdUrl(posting.externalId), { provider: "dover" });
    const parsed = parseOrNull(DoverJobDescriptionSchema, raw, { provider: "dover", slug: company.slug });
    if (!parsed) return "";
    return extractDoverJd(parsed);
  },
};
