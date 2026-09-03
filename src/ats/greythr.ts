import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { tenantOriginOr } from "./shared.js";

// tenant subdomain <slug>.greythr.com ("careerbuild" SPA)
// list: POST /hire/api/career/published_jobs/, JD inline (no fetchJd needed); location IDs have no public id->name map, so location falls back to a JD-text regex (JD_LOCATION_RE)

export const GreythrJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string().nullable().optional(),
  req_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  apply_url: z.string().nullable().optional(),
  is_remote: z.boolean().nullable().optional(),
  created_at: z.string().nullable().optional(),
});
export type GreythrJob = z.infer<typeof GreythrJobSchema>;

const ListResponseSchema = z.object({ data: z.array(GreythrJobSchema) });

/** Tenant host origin, e.g. "https://firstclub.greythr.com"; prefers an explicit tenant_url host, else builds it from the slug. */
export function greythrBase(company: AdapterCompany): string {
  return tenantOriginOr(company, (slug) => `https://${slug}.greythr.com`);
}

export const greythrAdapter: AtsAdapter = {
  provider: "greythr",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `${greythrBase(company)}/hire/api/career/published_jobs/`;
    const raw = await atsFetchJson(url, { method: "POST", body: {}, provider: "greythr" });

    const parsed = parseOrThrow(ListResponseSchema, raw, { provider: "greythr", slug: company.slug });

    return parsed.data.map((j) => normalizeGreythr(company, j));
  },
};

// Stops at tag/line boundaries so it doesn't swallow the next field.
const JD_LOCATION_RE = /\blocation\s*:\s*([^\n<,;|]{2,60})/i;
export function greythrLocationFromJd(jdText: string): string | null {
  const m = JD_LOCATION_RE.exec(jdText);
  const loc = m?.[1]?.trim() ?? "";
  return loc !== "" ? loc : null;
}

export function normalizeGreythr(company: AdapterCompany, j: GreythrJob): NormalizedPosting {
  const base = greythrBase(company);
  const jobUrl =
    j.apply_url && /^https?:\/\//i.test(j.apply_url)
      ? j.apply_url
      : j.slug
        ? `${base}/hire/jobs/${j.slug}`
        : `${base}/hire/jobs`;

  const jdText = htmlToText(j.description);
  return {
    provider: "greythr",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl,
    location: greythrLocationFromJd(jdText),
    isRemote: j.is_remote === true,
    jdText,
    postedAt: j.created_at ?? null,
  };
}
