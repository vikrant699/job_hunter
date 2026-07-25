import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { tenantOriginOr } from "./shared.js";

// greytHR public recruitment board ("careerbuild" SPA). Each tenant is a
// subdomain: <slug>.greythr.com. The board is a JS app backed by a JSON API:
//
//   list: POST https://<slug>.greythr.com/hire/api/career/published_jobs/
//         body {} -> { "data": [ { id, title, slug, description(HTML),
//                                  apply_url, is_remote, created_at, ... } ] }
//
// The list endpoint already returns the full HTML JD, so jdText is populated
// here and no fetchJd is needed. Locations come back as opaque numeric IDs with
// no public id->name map, so `location` is left null and the pipeline's
// text-based location filter (title + JD) decides; `is_remote` is honored.

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

/** Tenant host origin, e.g. "https://firstclub.greythr.com". Prefers an explicit
 *  tenant_url host when set, else builds it from the slug (the subdomain). */
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

export function normalizeGreythr(company: AdapterCompany, j: GreythrJob): NormalizedPosting {
  const base = greythrBase(company);
  const jobUrl =
    j.apply_url && /^https?:\/\//i.test(j.apply_url)
      ? j.apply_url
      : j.slug
        ? `${base}/hire/jobs/${j.slug}`
        : `${base}/hire/jobs`;

  return {
    provider: "greythr",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl,
    location: null, // greytHR exposes only opaque location IDs; text filter decides
    isRemote: j.is_remote === true,
    jdText: htmlToText(j.description),
    postedAt: j.created_at ?? null,
  };
}
