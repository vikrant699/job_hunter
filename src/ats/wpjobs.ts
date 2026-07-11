// src/ats/wpjobs.ts — generic WordPress REST API adapter for career sites that
// expose jobs as a custom post type. Confirmed live on Fibe/EarlySalary:
//   GET https://altcont.fibe.in/wp-json/wp/v2/jobpost?per_page=100&page=1&order=desc&_embed=1
// -> a JSON ARRAY of WP posts (no auth). The post-type slug varies by site
// (jobpost / job / career / vacancy / job-listing / ...), so it's configurable
// via `apiMeta.postType` (default "jobpost"); the host comes from `tenantUrl`
// (the WP origin, not the wp-json path itself).
//
// Pagination: `atsFetchJson` only returns the parsed body, not headers, so we
// can't read WP's `X-WP-Total`/`X-WP-TotalPages` response headers here. Fall
// back to the same short-page convention the other simple list APIs use
// (Workday/SmartRecruiters/Eightfold/Oracle): a page shorter than `per_page`
// (including empty) ends pagination.
//
// Location: WP job plugins store this inconsistently. Best-effort chain, most
// to least reliable (confirmed against Fibe's live data, which has none of
// this in `acf` — only an external-ATS redirect payload — but *does* carry a
// `jobpost_location` taxonomy):
//   1. `_embedded['wp:term']` (requires `_embed=1`, added to every request) —
//      the taxonomy term's human-readable `name`, for any taxonomy whose name
//      contains "location" (e.g. Fibe's `jobpost_location`).
//   2. `class_list` — WP renders taxonomy terms as `<taxonomy>-<term-slug>`
//      classes even without `_embed`; catches sites where embedding is
//      disabled. Slug is de-kebabed to Title Case.
//   3. `acf` / `meta` — a string field whose key looks location-related
//      (location/city/office/workplace), skipping anything that looks like a
//      redirect payload.
//   4. A "Location:" / "Job location:" label embedded in the post body copy
//      (seen literally in one live Fibe posting).
//   5. Otherwise null — the pipeline's text-based location filter decides.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { JsonValueSchema, type JsonValue } from "../util/json.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

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
  acf: z.record(z.string(), JsonValueSchema).nullable().optional(),
  meta: z.record(z.string(), JsonValueSchema).nullable().optional(),
  _embedded: WpEmbeddedSchema.nullable().optional(),
});
export type WpPost = z.infer<typeof WpPostSchema>;

const WpListSchema = z.array(WpPostSchema);

/** Origin (https://<host>) from the tenant/wp-json URL, falling back to the careers URL. */
function wpjobsOrigin(company: AdapterCompany): string {
  const u = new URL(company.tenantUrl ?? company.careersUrl);
  return `${u.protocol}//${u.host}`;
}

/** Custom post-type slug for the jobs CPT; configurable per tenant. */
export function wpjobsPostType(company: AdapterCompany): string {
  return company.apiMeta?.postType ?? "jobpost";
}

/** Paged list URL for the WP REST API, with embedded taxonomy terms for location. */
export function wpjobsApiUrl(company: AdapterCompany, page: number): string {
  const postType = wpjobsPostType(company);
  return `${wpjobsOrigin(company)}/wp-json/wp/v2/${postType}?per_page=${PER_PAGE}&page=${page}&order=desc&_embed=1`;
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
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
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

/** Best-effort location extraction; see the module doc comment for the priority chain. */
export function wpjobsLocation(post: WpPost): string | null {
  return (
    locationFromEmbeddedTerms(post) ??
    locationFromClassList(post) ??
    firstStringLocationField(post.acf) ??
    firstStringLocationField(post.meta) ??
    locationFromContent(post.content?.rendered)
  );
}

/** Prefer date_gmt (true UTC) over the site-local `date` field; null if neither parses. */
function wpjobsPostedAt(post: WpPost): string | null {
  if (post.date_gmt) {
    const ms = Date.parse(`${post.date_gmt}Z`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  if (post.date) {
    const ms = Date.parse(post.date);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
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
        const parsed = WpListSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { slug: company.slug, issues: parsed.error.issues.slice(0, 2) },
            "wpjobs list schema mismatch",
          );
          throw new Error(`wpjobs list response failed schema for ${company.slug}`);
        }
        return {
          items: parsed.data.map((p) => normalizeWpjobs(company, p)),
          total: null,
          rawCount: parsed.data.length,
        };
      },
    });
  },
  // The list response carries the full post body in content.rendered — no fetchJd needed.
};
