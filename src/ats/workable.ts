// Workable widget API: GET apply.workable.com/api/v1/widget/accounts/<slug>?details=true; JD inline in the response.
// The widget repeats a multi-location job once per location (same shortcode), so rows are merged per shortcode.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { joinLocation } from "./shared.js";
import { matchGroup } from "../util/regex.js";

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

const TENANT_ACCOUNT_RE = /apply\.workable\.com\/(?:api\/v1\/widget\/accounts\/)?([^/?#]+)/;

function accountOf(company: AdapterCompany): string {
  return company.apiMeta?.boardSlug ?? matchGroup(TENANT_ACCOUNT_RE, company.tenantUrl ?? "") ?? company.slug;
}

export const workableAdapter: AtsAdapter = {
  provider: "workable",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(accountOf(company))}?details=true`;
    const raw = await atsFetchJson(url, { provider: "workable" });
    const parsed = parseOrThrow(ResponseSchema, raw, { provider: "workable", slug: company.slug });
    return mergeByShortcode(parsed.jobs).map((j) => normalizeWorkable(company, j));
  },
};

function mergeByShortcode(jobs: Job[]): Job[] {
  const merged = new Map<string, Job>();
  for (const j of jobs) {
    const own = j.locations ?? [{ city: j.city, region: j.state, country: j.country }];
    const prev = merged.get(j.shortcode);
    merged.set(j.shortcode, prev ? { ...prev, locations: [...(prev.locations ?? []), ...own] } : { ...j, locations: own });
  }
  return [...merged.values()];
}

export function normalizeWorkable(company: AdapterCompany, j: Job): NormalizedPosting {
  // Join EVERY location: keeping only the first would geo-reject postings like "Boston; Bengaluru".
  const locs = (j.locations ?? [])
    .map((l) => joinLocation(l.city, l.region, l.country))
    .filter((s): s is string => s !== null);
  const location =
    locs.length > 0 ? [...new Set(locs)].join("; ") : joinLocation(j.city, j.state, j.country);
  return {
    provider: "workable",
    externalId: j.shortcode,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.url ?? j.shortlink ?? `https://apply.workable.com/${company.slug}/`,
    location,
    isRemote: j.telecommuting === true,
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.published_on ?? j.created_at ?? null,
  };
}
