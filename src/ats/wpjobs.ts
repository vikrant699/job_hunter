// src/ats/wpjobs.ts — generic WordPress REST API adapter for career sites exposing jobs as a custom post type (confirmed live on Fibe/EarlySalary).
// list: GET <origin>/wp-json/wp/v2/<postType>?per_page=100&page=<n>&order=desc&_embed=1 -> JSON array of WP posts, no auth; postType from apiMeta.postType (default "jobpost"), host from tenantUrl.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso, tenantOrigin } from "./shared.js";

const PER_PAGE = 100; // WP REST API max page size

const WpTermSchema = z.object({
  taxonomy: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const WpEmbeddedSchema = z.object({
  "wp:term": z.array(z.array(WpTermSchema)).nullable().optional(),
});

export const WpPostSchema = z.object({
  id: z.union([z.string(), z.number()]),
  date: z.string().nullable().optional(),
  date_gmt: z.string().nullable().optional(),
  link: z.string(),
  title: z.object({ rendered: z.string() }),
  content: z.object({ rendered: z.string().nullable().optional() }).nullable().optional(),
  class_list: z.array(z.string()).nullable().optional(),
  // WP serializes an EMPTY acf/meta set as [] (PHP array) not {} — accept both (verified live on careers.chingari.io).
  acf: z.union([z.record(z.string(), JsonValueSchema), z.array(JsonValueSchema)]).nullable().optional(),
  meta: z.union([z.record(z.string(), JsonValueSchema), z.array(JsonValueSchema)]).nullable().optional(),
  _embedded: WpEmbeddedSchema.nullable().optional(),
});
export type WpPost = z.infer<typeof WpPostSchema>;

const WpListSchema = z.array(WpPostSchema);

// Custom post-type slug for the jobs CPT; configurable per tenant.
export function wpjobsPostType(company: AdapterCompany): string {
  return company.apiMeta?.postType ?? "jobpost";
}

// Paged list URL for the WP REST API, with embedded taxonomy terms for location.
export function wpjobsApiUrl(company: AdapterCompany, page: number): string {
  const postType = wpjobsPostType(company);
  return `${tenantOrigin(company)}/wp-json/wp/v2/${postType}?per_page=${PER_PAGE}&page=${page}&order=desc&_embed=1`;
}

const LOCATION_KEY_RE = /location|city|office|workplace/i;
const REDIRECT_KEY_RE = /redirect/i;

function locationFromEmbeddedTerms(post: WpPost): string | null {
  const groups = post._embedded?.["wp:term"];
  if (!groups) return null;
  for (const group of groups) {
    for (const term of group) {
      if (term.taxonomy && term.name && /location/i.test(term.taxonomy)) return term.name;
    }
  }
  return null;
}

function titleCaseFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join(" ");
}

function locationFromClassList(post: WpPost): string | null {
  for (const cls of post.class_list ?? []) {
    const m = /_location-(.+)$/.exec(cls);
    if (m?.[1]) return titleCaseFromSlug(m[1]);
  }
  return null;
}

function firstStringLocationField(fields: Record<string, JsonValue> | null | undefined): string | null {
  if (!fields) return null;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (REDIRECT_KEY_RE.test(key)) continue;
    if (LOCATION_KEY_RE.test(key)) return trimmed;
  }
  return null;
}

function locationFromContent(html: string | null | undefined): string | null {
  const text = htmlToText(html);
  const m = /(?:job\s*)?location\s*:\s*([^\n]+)/i.exec(text);
  const found = m?.[1]?.trim();
  return found ? found : null;
}

// Best-effort location, most to least reliable: embedded location taxonomy term, then class_list, then an acf/meta field, then a "Location:" label in the body text.
export function wpjobsLocation(post: WpPost): string | null {
  return (
    locationFromEmbeddedTerms(post) ??
    locationFromClassList(post) ??
    firstStringLocationField(Array.isArray(post.acf) ? null : post.acf) ??
    firstStringLocationField(Array.isArray(post.meta) ? null : post.meta) ??
    locationFromContent(post.content?.rendered)
  );
}

// Prefers date_gmt (true UTC) over the site-local date field; date_gmt has no zone designator, so "Z" is appended before parsing or Date.parse would read it as local time.
function wpjobsPostedAt(post: WpPost): string | null {
  return dateToIso(post.date_gmt ? `${post.date_gmt}Z` : null) ?? dateToIso(post.date);
}

export function normalizeWpjobs(company: AdapterCompany, post: WpPost): NormalizedPosting {
  const location = wpjobsLocation(post);
  return {
    provider: "wpjobs",
    externalId: String(post.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: htmlToText(post.title.rendered),
    jobUrl: post.link,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(post.content?.rendered),
    postedAt: wpjobsPostedAt(post),
  };
}

export const wpjobsAdapter: AtsAdapter = {
  provider: "wpjobs",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "wpjobs",
      company: company.slug,
      pageSize: PER_PAGE,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(wpjobsApiUrl(company, page + 1), { provider: "wpjobs" });
        const parsed = parseOrThrow(WpListSchema, raw, { provider: "wpjobs", slug: company.slug });
        return {
          items: parsed.map((p) => normalizeWpjobs(company, p)),
          total: null, // atsFetchJson exposes no X-WP-Total header, so pagination relies on paginate()'s short-page convention
          rawCount: parsed.length,
        };
      },
    });
  },
  // The list response carries the full post body in content.rendered — no fetchJd needed.
};
