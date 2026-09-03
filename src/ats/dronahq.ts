// list: GET dronahq.com/wp-json/wp/v2/career?per_page=100&page=<N> (WP REST, no auth); no X-WP-Total header, so a short/empty page ends pagination
// doesn't reuse the generic wpjobs adapter: JD is wrapped in WPBakery shortcode tokens and location is a fixed HTML fragment in the body, not wpjobs's acf/taxonomy/meta shape
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, paginate, dateToIso } from "./shared.js";

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

export function dronahqListUrl(page: number): string {
  return `${API_ORIGIN}/wp-json/wp/v2/${POST_TYPE}?per_page=${PER_PAGE}&page=${page}`;
}

// vc_* shortcode tokens wrap plain HTML rather than replacing it; stripping just the bracketed tokens leaves the markup for htmlToText.
const SHORTCODE_RE = /\[[^\]]*\]/g;

export function stripDronahqShortcodes(html: string): string {
  return html.replace(SHORTCODE_RE, "");
}

export function buildDronahqJd(contentHtml: string | null | undefined): string {
  if (!contentHtml) return "";
  return htmlToText(stripDronahqShortcodes(contentHtml));
}

// job-header banner embeds location as <span class="location">Location</span><span><span>Mumbai, ...</span></span>
const LOCATION_RE = /<span class="location">Location<\/span>\s*<span>\s*<span>\s*([^<]+?)\s*<\/span>/i;

/** Null if the markup isn't found - the pipeline's own location gate still runs against jdText regardless. */
export function dronahqLocationFromContent(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = LOCATION_RE.exec(html);
  const found = m?.[1]?.trim();
  return found ? found : null;
}

// Same header banner carries a work-type span too ("wokr-type" typo is DronaHQ's own).
const WORK_TYPE_RE = /class="wokr-type"\s*>\s*([^<]+?)\s*<\/span>/i;

export function dronahqWorkTypeFromContent(html: string | null | undefined): string | null {
  if (!html) return null;
  const m = WORK_TYPE_RE.exec(html);
  const found = m?.[1]?.trim();
  return found ? found : null;
}

/** Prefers date_gmt (true UTC); "Z" is appended since WP's date_gmt has no zone designator of its own. */
function dronahqPostedAt(job: DronahqJob): string | null {
  return dateToIso(job.date_gmt ? `${job.date_gmt}Z` : null) ?? dateToIso(job.date);
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
