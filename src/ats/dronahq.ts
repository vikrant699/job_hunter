// src/ats/dronahq.ts — DronaHQ careers, a single-company WordPress site
// exposing its jobs as a custom post type ("career") on the standard WP
// REST API:
//
//   GET https://www.dronahq.com/wp-json/wp/v2/career?per_page=100&page=<N>
//   -> a JSON ARRAY of WP posts, no auth. Confirmed live 2026-07-15 (4 open
//   roles, 1 page).
//
// This does NOT reuse the generic `wpjobs` adapter: DronaHQ's post body is
// built from WPBakery/`vc_*` shortcodes (`[vc_row][vc_column]...[/vc_column]
// [/vc_row]`) wrapping hand-authored HTML — `wpjobs`'s plain `htmlToText`
// would leave the literal `[vc_row]`/`[/vc_column]` tokens in the JD text.
// DronaHQ also has no `acf`/taxonomy location data (acf is always `[]` on
// this tenant); the only location signal is a fixed HTML fragment embedded
// in the post body itself:
//   <span class="location">Location</span>
//     <span><span> Mumbai, Maharashtra, India </span>
//       <span class="wokr-type"> Hybrid </span></span>
// — a shape `wpjobs`'s generic location chain (embedded terms / class_list /
// acf / meta / "Location:" body text) doesn't match either.
//
// Pagination: `atsFetchJson` only returns the parsed body, not response
// headers, so `X-WP-Total`/`X-WP-TotalPages` aren't readable here (same
// constraint documented in wpjobs.ts). Falls back to the same short/empty
// page convention as the other simple list APIs: a page shorter than
// `per_page` (including empty) ends pagination. Never truncates — every
// page is fetched until a short page or the runaway backstop.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate } from "./shared.js";

const API_ORIGIN = "https://www.dronahq.com";
const POST_TYPE = "career";
const PER_PAGE = 100;

const DronahqJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  date: z.string().nullable().optional(),
  date_gmt: z.string().nullable().optional(),
  link: z.string(),
  title: z.object({ rendered: z.string() }),
  content: z.object({ rendered: z.string().nullable().optional() }).nullable().optional(),
});
export type DronahqJob = z.infer<typeof DronahqJobSchema>;

const DronahqListSchema = z.array(DronahqJobSchema);

/** Paged list URL for the `career` custom post type. */
export function dronahqListUrl(page: number): string {
  return `${API_ORIGIN}/wp-json/wp/v2/${POST_TYPE}?per_page=${PER_PAGE}&page=${page}`;
}

// WPBakery/vc_* (and any other WP page-builder) shortcode tokens, e.g.
// "[vc_row]", "[/vc_column_text]", "[vc_row css=\"...\"]". These wrap plain
// HTML rather than replacing it, so removing the bracketed tokens (and
// nothing else) leaves the underlying markup for htmlToText to handle.
const SHORTCODE_RE = /\[[^\]]*\]/g;

/** Strip WPBakery/page-builder shortcode tokens, leaving the wrapped HTML intact. */
export function stripDronahqShortcodes(html: string): string {
  return html.replace(SHORTCODE_RE, "");
}

/** Build the plain-text JD: strip shortcode tokens, then strip HTML. */
export function buildDronahqJd(contentHtml: string | null | undefined): string {
  if (!contentHtml) return "";
  return htmlToText(stripDronahqShortcodes(contentHtml));
}

// The job-header banner every posting shares embeds location as:
//   <span class="location">Location</span><span><span> Mumbai, ... </span>
const LOCATION_RE = /<span class="location">Location<\/span>\s*<span>\s*<span>\s*([^<]+?)\s*<\/span>/i;

/** Best-effort location, parsed from the fixed job-header markup in the post
 *  body. Null if the markup isn't found — the pipeline's own location gate
 *  still runs against jdText regardless. */
export function dronahqLocationFromContent(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = LOCATION_RE.exec(html);
  const found = m?.[1]?.trim();
  return found ? found : null;
}

// Same header banner also carries a work-type span, e.g.
//   <span class="wokr-type"> Hybrid </span> (sic — "wokr-type" typo is DronaHQ's own).
const WORK_TYPE_RE = /class="wokr-type"\s*>\s*([^<]+?)\s*<\/span>/i;

/** Best-effort work-type ("Hybrid"/"Remote"/"On-site"/...), parsed from the
 *  same job-header markup as the location. Null if not found. */
export function dronahqWorkTypeFromContent(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = WORK_TYPE_RE.exec(html);
  const found = m?.[1]?.trim();
  return found ? found : null;
}

/** Prefer date_gmt (true UTC) over the site-local `date` field; null if neither parses. */
function dronahqPostedAt(job: DronahqJob): string | null {
  if (job.date_gmt) {
    const ms = Date.parse(`${job.date_gmt}Z`);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  if (job.date) {
    const ms = Date.parse(job.date);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

export function normalizeDronahqJob(company: AdapterCompany, job: DronahqJob): NormalizedPosting {
  const contentHtml = job.content?.rendered;
  const location = dronahqLocationFromContent(contentHtml);
  const workType = dronahqWorkTypeFromContent(contentHtml);
  return {
    provider: "dronahq",
    externalId: String(job.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: htmlToText(job.title.rendered),
    jobUrl: job.link,
    location,
    isRemote: REMOTE_RE.test(location ?? "") || REMOTE_RE.test(workType ?? ""),
    jdText: buildDronahqJd(contentHtml),
    postedAt: dronahqPostedAt(job),
  };
}

export const dronahqAdapter: AtsAdapter = {
  provider: "dronahq",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    return paginate<NormalizedPosting>({
      provider: "dronahq",
      company: company.slug,
      pageSize: PER_PAGE,
      fetchPage: async (_offset, page) => {
        const raw = await atsFetchJson(dronahqListUrl(page + 1), { provider: "dronahq" });
        const parsed = parseOrThrow(DronahqListSchema, raw, { provider: "dronahq", slug: company.slug });
        return {
          items: parsed.map((j) => normalizeDronahqJob(company, j)),
          total: null,
          rawCount: parsed.length,
        };
      },
    });
  },
  // The list response carries the full post body in content.rendered — no fetchJd needed.
};
