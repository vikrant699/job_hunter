// src/ats/keka.ts
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

// Keka careers API — two UI generations, same Job[] response shape:
//   legacy embed widget:
//     GET <slug>.keka.com/careers/api/embedjobs/default/active/<orgGuid>
//     orgGuid is org-level (stable), extracted from the careers page HTML at
//     conversion time and stored in api_meta.orgGuid.
//   newer Blazor UI (e.g. signzy):
//     GET <slug>.keka.com/careers/api/jobs/default/active   (NO orgGuid — its
//     HTML embeds no GUID at all, which silently broke orgGuid-based conversion
//     and dormanted these tenants).
// A tenant without a stored orgGuid uses the Blazor endpoint; a tenant WITH one
// tries the embed endpoint first and falls back to the Blazor endpoint if that
// fails (covers tenants that migrated UIs after conversion). One-phase (JD inline).
const LocSchema = z.object({
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  countryName: z.string().nullable().optional(),
});
const JobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  description: z.string().nullable().optional(),
  jobLocations: z.array(LocSchema).nullable().optional(),
  jobNumber: z.string().nullable().optional(),
  publishedOn: z.string().nullable().optional(),
});
type Job = z.infer<typeof JobSchema>;
const ResponseSchema = z.array(JobSchema);

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Extract the org GUID embedded in a Keka careers page. Null if absent. */
export function extractKekaOrgGuid(html: string): string | null {
  return html.match(GUID_RE)?.[0] ?? null;
}

/** Legacy embed-API endpoint for a slug + orgGuid. */
export function kekaEmbedUrl(slug: string, orgGuid: string): string {
  return `https://${slug}.keka.com/careers/api/embedjobs/default/active/${orgGuid}`;
}

/** Newer Blazor-UI endpoint (no orgGuid). */
export function kekaJobsUrl(slug: string): string {
  return `https://${slug}.keka.com/careers/api/jobs/default/active`;
}

async function fetchKeka(company: AdapterCompany, url: string): Promise<NormalizedPosting[]> {
  const raw = await atsFetchJson(url, { provider: "keka" });
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "keka schema mismatch");
    throw new Error(`keka response failed schema for ${company.slug}`);
  }
  return parsed.data.map((j) => normalizeKeka(company, j));
}

export const kekaAdapter: AtsAdapter = {
  provider: "keka",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // The keka subdomain is usually the registry slug, but apiMeta.boardSlug
    // overrides it when they differ (e.g. browntape's tenant is "ginesysone",
    // greaves' is "peopleatgems").
    const sub = company.apiMeta?.boardSlug ?? company.slug;
    const orgGuid = company.apiMeta?.orgGuid;
    // No orgGuid -> Blazor-UI tenant (no GUID to store). With an orgGuid, try
    // the legacy embed endpoint first, then fall back to the Blazor endpoint
    // for tenants that migrated UIs after conversion.
    if (!orgGuid) return fetchKeka(company, kekaJobsUrl(sub));
    try {
      return await fetchKeka(company, kekaEmbedUrl(sub, orgGuid));
    } catch (e) {
      logger.warn(
        { slug: company.slug, err: String(e).slice(0, 80) },
        "keka embed endpoint failed; trying Blazor jobs endpoint",
      );
      return fetchKeka(company, kekaJobsUrl(sub));
    }
  },
};

export function normalizeKeka(company: AdapterCompany, j: Job): NormalizedPosting {
  const loc = (j.jobLocations ?? [])
    .map((l) => [l.city, l.state, l.countryName].map((s) => (s ?? "").trim()).filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
  const location = loc || null;
  return {
    provider: "keka",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: `https://${company.apiMeta?.boardSlug ?? company.slug}.keka.com/careers/jobdetails/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.publishedOn ?? null,
  };
}
