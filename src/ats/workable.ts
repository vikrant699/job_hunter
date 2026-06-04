// src/ats/workable.ts
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";

// Workable public widget API:
//   GET apply.workable.com/api/v1/widget/accounts/<slug>?details=true
// One-phase: details=true returns the full HTML description inline.
const LocationSchema = z.object({
  country: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
});
const JobSchema = z.object({
  title: z.string(),
  shortcode: z.string(),
  url: z.string().nullable().optional(),
  shortlink: z.string().nullable().optional(),
  telecommuting: z.boolean().nullable().optional(),
  published_on: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  locations: z.array(LocationSchema).nullable().optional(),
  description: z.string().nullable().optional(),
});
type Job = z.infer<typeof JobSchema>;
const ResponseSchema = z.object({ name: z.string().optional(), jobs: z.array(JobSchema) });

export const workableAdapter: AtsAdapter = {
  provider: "workable",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(company.slug)}?details=true`;
    const raw = await atsFetchJson(url, { provider: "workable" });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 2) }, "workable schema mismatch");
      throw new Error(`workable response failed schema for ${company.slug}`);
    }
    return parsed.data.jobs.map((j) => normalizeWorkable(company, j));
  },
};

export function normalizeWorkable(company: AdapterCompany, j: Job): NormalizedPosting {
  const loc = j.locations?.[0];
  const fields = [loc?.city ?? j.city, loc?.region ?? j.state, loc?.country ?? j.country];
  const parts = fields.map((s) => (s ?? "").trim()).filter(Boolean);
  return {
    provider: "workable",
    externalId: j.shortcode,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.url ?? j.shortlink ?? `https://apply.workable.com/${company.slug}/`,
    location: parts.length ? parts.join(", ") : null,
    isRemote: j.telecommuting === true,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.published_on ?? j.created_at ?? null,
  };
}
