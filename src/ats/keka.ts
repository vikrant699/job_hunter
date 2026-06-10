// src/ats/keka.ts
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

// Keka embed API:
//   GET <slug>.keka.com/careers/api/embedjobs/default/active/<orgGuid>  -> Job[]
// orgGuid is org-level (stable); extracted once from the careers page at
// conversion time and stored in api_meta.orgGuid. One-phase (description inline).
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

/** Embed-API endpoint for a slug + orgGuid; shared by the adapter and discovery validation. */
export function kekaEmbedUrl(slug: string, orgGuid: string): string {
  return `https://${slug}.keka.com/careers/api/embedjobs/default/active/${orgGuid}`;
}

export const kekaAdapter: AtsAdapter = {
  provider: "keka",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const orgGuid = company.apiMeta?.orgGuid;
    if (!orgGuid) throw new Error(`keka adapter requires apiMeta.orgGuid for ${company.slug}`);
    const url = kekaEmbedUrl(company.slug, orgGuid);
    const raw = await atsFetchJson(url, { provider: "keka" });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "keka schema mismatch");
      throw new Error(`keka response failed schema for ${company.slug}`);
    }
    return parsed.data.map((j) => normalizeKeka(company, j));
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
    jobUrl: `https://${company.slug}.keka.com/careers/jobdetails/${j.id}`,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.publishedOn ?? null,
  };
}
