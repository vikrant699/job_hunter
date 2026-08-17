// src/ats/ycombinator.ts — Y Combinator company job boards. There is no public API (no
// Algolia call fires client-side for a single company's board). Instead both the job list
// AND each job's full JD are server-rendered into the page as an HTML-attribute-escaped
// JSON blob (`data-page="{...}"`). The listing page's jobPostings[] is a teaser only (no
// description) — fetchJd re-fetches the job's own page, whose data-page props.job.description
// holds the full JD (plain markdown text, not HTML).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchText, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { decodeAttrEntities } from "./htmlText.js";
import { matchGroup } from "../util/regex.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const YC_ORIGIN = "https://www.ycombinator.com";

// Pulls the data-page="{...}" React-props JSON island out of a YC jobs page. YC
// entity-escapes double quotes inside the attribute, so the first "..." run after
// `data-page=` is exactly the JSON payload.
export function extractYcDataPage(html: string): JsonValue | null {
  const raw = matchGroup(/data-page="([^"]*)"/, html);
  if (raw === null) return null;
  return tryParseJson(decodeAttrEntities(raw));
}

export const YcJobListingSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  url: z.string(),
  location: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});
export type YcJobListing = z.infer<typeof YcJobListingSchema>;

const YcJobsListPageSchema = z.object({
  props: z.object({
    jobPostings: z.array(YcJobListingSchema),
  }),
});

export const YcJobDetailSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullable().optional(),
});
export type YcJobDetail = z.infer<typeof YcJobDetailSchema>;

const YcJobDetailPageSchema = z.object({
  props: z.object({
    job: YcJobDetailSchema,
  }),
});

// The company's public jobs board.
export function ycJobsPageUrl(company: AdapterCompany): string {
  return `${YC_ORIGIN}/companies/${company.apiMeta?.boardSlug ?? company.slug}/jobs`;
}

// Job listing `url` is already site-relative.
export function ycJobUrl(relativeOrAbsolute: string): string {
  return relativeOrAbsolute.startsWith("http") ? relativeOrAbsolute : `${YC_ORIGIN}${relativeOrAbsolute}`;
}

export function ycJobsFromListPage(pageData: JsonValue, slug: string): YcJobListing[] {
  const parsed = parseOrThrow(YcJobsListPageSchema, pageData, { provider: "ycombinator", slug, what: "jobPostings" });
  return parsed.props.jobPostings;
}

// Null (not throw) on mismatch — fetchJd falls back to an empty JD.
export function ycJobFromDetailPage(pageData: JsonValue, slug: string, externalId: string): YcJobDetail | null {
  const parsed = YcJobDetailPageSchema.safeParse(pageData);
  if (!parsed.success) {
    logger.debug(
      { slug, externalId, issues: parsed.error.issues.slice(0, 2) },
      "ycombinator job-detail schema mismatch"
    );
    return null;
  }
  return parsed.data.props.job;
}

// YC renders createdAt/lastActive as date-fns-style relative strings ("about 1 month",
// "over 2 years"). Best-effort: pull the leading count + unit, ignore the qualifier word.
const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

export function parseYcRelative(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.toLowerCase().match(/(\d+)\s*(minute|hour|day|week|month|year)s?/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === undefined) return null;
  const unitMs = UNIT_MS[unit];
  if (unitMs === undefined) return null;
  return new Date(Date.now() - n * unitMs).toISOString();
}

export function normalizeYc(company: AdapterCompany, j: YcJobListing): NormalizedPosting {
  const location = j.location ?? null;
  return {
    provider: "ycombinator",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: ycJobUrl(j.url),
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: "",
    postedAt: parseYcRelative(j.createdAt),
  };
}

export const ycombinatorAdapter: AtsAdapter = {
  provider: "ycombinator",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const html = await atsFetchText(ycJobsPageUrl(company), { provider: "ycombinator" });
    const pageData = extractYcDataPage(html);
    if (!pageData) throw new Error(`ycombinator: no data-page island for ${company.slug}`);
    const jobs = ycJobsFromListPage(pageData, company.slug);
    return jobs.map((j) => normalizeYc(company, j));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const html = await atsFetchText(posting.jobUrl, { provider: "ycombinator" });
    const pageData = extractYcDataPage(html);
    if (!pageData) return "";
    const job = ycJobFromDetailPage(pageData, company.slug, posting.externalId);
    // description is already plain markdown text (not HTML) and was entity-decoded once above.
    return (job?.description ?? "").trim();
  },
};
