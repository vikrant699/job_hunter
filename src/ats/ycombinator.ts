// src/ats/ycombinator.ts — Y Combinator company job boards
// (https://www.ycombinator.com/companies/<slug>/jobs). There is no public
// API (no Algolia call fires client-side for a single company's board — the
// Algolia bundles loaded on the page serve YC's own cross-company search).
// Instead both the job list AND each job's full JD are server-rendered
// straight into the page as an HTML-attribute-escaped JSON blob:
//   <div ... data-page="{&quot;component&quot;:&quot;WaasShowJobsPage&quot;,
//     &quot;props&quot;:{...,&quot;jobPostings&quot;:[...]}}">
// The listing page's jobPostings[] is a teaser only (no description) —
// fetchJd re-fetches the job's own page, whose data-page is component
// "WaasShowJobPage" with props.job.description holding the full JD
// (plain markdown text, not HTML).
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchText } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { decodeNumericEntities } from "./html-text.js";

const YC_ORIGIN = "https://www.ycombinator.com";

/** Entities the page encodes when serializing the React props JSON into the `data-page` attribute. */
const ATTR_ENTITY_MAP: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&#39;": "'",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&#x2F;": "/",
  "&nbsp;": " ",
};

function decodeAttrEntities(s: string): string {
  let out = s;
  for (const [k, v] of Object.entries(ATTR_ENTITY_MAP)) out = out.split(k).join(v);
  return decodeNumericEntities(out);
}

/**
 * Pull the `data-page="{...}"` React-props JSON island out of a YC
 * companies/*.jobs* page. The attribute's content never contains a raw
 * (unescaped) double quote — YC entity-escapes them as `&quot;` — so the
 * first `"..."` run after `data-page=` is exactly the JSON payload.
 */
export function extractYcDataPage(html: string): unknown | null {
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) return null;
  try {
    return JSON.parse(decodeAttrEntities(m[1]!));
  } catch {
    return null;
  }
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

/** The company's public jobs board. */
export function ycJobsPageUrl(company: AdapterCompany): string {
  return `${YC_ORIGIN}/companies/${company.apiMeta?.boardSlug ?? company.slug}/jobs`;
}

/** Job listing `url` is already site-relative (e.g. "/companies/<slug>/jobs/<id>-title"). */
export function ycJobUrl(relativeOrAbsolute: string): string {
  return relativeOrAbsolute.startsWith("http") ? relativeOrAbsolute : `${YC_ORIGIN}${relativeOrAbsolute}`;
}

/** Extract jobPostings[] from a parsed jobs-list page's data-page payload. Throws on schema mismatch. */
export function ycJobsFromListPage(pageData: unknown, slug: string): YcJobListing[] {
  const parsed = YcJobsListPageSchema.safeParse(pageData);
  if (!parsed.success) {
    logger.warn({ slug, issues: parsed.error.issues.slice(0, 3) }, "ycombinator schema mismatch");
    throw new Error(`ycombinator: jobPostings schema mismatch for ${slug}`);
  }
  return parsed.data.props.jobPostings;
}

/** Extract props.job from a parsed job-detail page's data-page payload. Null (not throw) on mismatch — fetchJd falls back to an empty JD. */
export function ycJobFromDetailPage(pageData: unknown, slug: string, externalId: string): YcJobDetail | null {
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

// YC renders createdAt/lastActive as date-fns-style relative strings ("about 1
// month", "over 2 years", "28 days", "almost 3 years", "less than a minute").
// Best-effort: pull the leading count + unit and ignore the qualifier word.
// Returns null for anything without a parseable count.
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
  const unitMs = UNIT_MS[m[2]!];
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
    // The description is already plain markdown text (not HTML) and was
    // entity-decoded once above — nothing more to strip.
    return (job?.description ?? "").trim();
  },
};
