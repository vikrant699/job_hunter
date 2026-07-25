// src/ats/sensehq.ts — SenseHQ career sites (Next.js), e.g. Tiger Analytics,
// Marico. The careers page embeds a `<script id="__NEXT_DATA__">` JSON island
// with `props.pageProps.jobsData = { rows, count }` and `props.buildId`. Small
// boards fit entirely in that first page; larger ones need the paginated
// `_next/data/<buildId>/jobs.json` endpoint the client itself calls, which
// uses the SAME jobsData shape (minus `props`/`buildId`) and is 0-indexed —
// `page=0` returns rows [0, pageSize), matching the initial page's rows as
// its own prefix. `count` can run stale, so pagination termination never
// relies on it; only a short/empty page ends the loop. Descriptions come back
// inline as `description_external` HTML — no per-job fetch needed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchHtml, atsFetchJson } from "./http.js";
import { REMOTE_RE, paginate, tenantOrigin } from "./shared.js";
import { matchGroup } from "../util/regex.js";

const PAGE_SIZE = 50;

export const SenseHqRowSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  location: z.string().nullable().optional(),
  description_external: z.string().nullable().optional(),
  workplace_type: z.string().nullable().optional(),
  job_status: z.string().nullable().optional(),
  created_on: z.number().nullable().optional(),
  code: z.string().nullable().optional(),
});
export type SenseHqRow = z.infer<typeof SenseHqRowSchema>;

const SenseHqJobsDataSchema = z.object({
  rows: z.array(SenseHqRowSchema),
  count: z.number().nullable().optional(),
});

const SenseHqPagePropsSchema = z.object({ jobsData: SenseHqJobsDataSchema });

// Initial SSR page: `<script id="__NEXT_DATA__">` island — carries buildId.
const SenseHqInitialDataSchema = z.object({
  buildId: z.string(),
  props: z.object({ pageProps: SenseHqPagePropsSchema }),
});

// `_next/data/<buildId>/jobs.json` page: same pageProps, no buildId/props wrapper.
const SenseHqPaginatedDataSchema = z.object({ pageProps: SenseHqPagePropsSchema });

export interface SenseHqJobsData {
  rows: SenseHqRow[];
  count: number | null;
}

/**
 * Extract the `__NEXT_DATA__` JSON island from a SenseHQ page. Anchored on
 * the script's `id` attribute, which is stable across Next.js redeploys
 * (unlike `buildId`, which lives inside the parsed payload). Returns null
 * when the script is absent or its body isn't valid JSON.
 */
export function extractSenseHqNextData(html: string): unknown | null {
  const raw = matchGroup(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/, html);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Read `buildId` + `jobsData` off the initial page's parsed island. Null on shape mismatch. */
export function senseHqInitialJobsData(nextData: unknown): (SenseHqJobsData & { buildId: string }) | null {
  const parsed = SenseHqInitialDataSchema.safeParse(nextData);
  if (!parsed.success) return null;
  const { rows, count } = parsed.data.props.pageProps.jobsData;
  return { buildId: parsed.data.buildId, rows, count: count ?? null };
}

/** Read `jobsData` off a `_next/data/.../jobs.json` page. Null on shape mismatch. */
export function senseHqPaginatedJobsData(pageJson: unknown): SenseHqJobsData | null {
  const parsed = SenseHqPaginatedDataSchema.safeParse(pageJson);
  if (!parsed.success) return null;
  const { rows, count } = parsed.data.pageProps.jobsData;
  return { rows, count: count ?? null };
}

/** Paginated jobs.json URL — mirrors the query params the client itself sends. */
export function senseHqPageUrl(origin: string, buildId: string, page: number, pageSize: number): string {
  return (
    `${origin}/careers/_next/data/${buildId}/jobs.json` +
    `?page=${page}&pageSize=${pageSize}&department=&location=&title=&sortBy=&orderBy=ASC` +
    `&minExp=0&maxExp=100&jobType=&workplaceType=`
  );
}

export function normalizeSenseHq(company: AdapterCompany, origin: string, r: SenseHqRow): NormalizedPosting {
  const id = String(r.id);
  const location = r.location ?? null;
  return {
    provider: "sensehq",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.title,
    jobUrl: `${origin}/careers/jobs/${id}`,
    location,
    isRemote: REMOTE_RE.test(`${r.workplace_type ?? ""} ${location ?? ""}`),
    jdText: htmlToText(r.description_external ?? ""),
    postedAt: typeof r.created_on === "number" ? new Date(r.created_on).toISOString() : null,
  };
}

export const sensehqAdapter: AtsAdapter = {
  provider: "sensehq",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = tenantOrigin(company);
    const { html } = await atsFetchHtml(`${origin}/careers`, { provider: "sensehq" });
    const nextData = extractSenseHqNextData(html);
    if (!nextData) throw new Error(`sensehq: no __NEXT_DATA__ island for ${company.slug}`);
    const initial = senseHqInitialJobsData(nextData);
    if (!initial) throw new Error(`sensehq: unexpected __NEXT_DATA__ shape for ${company.slug}`);
    const { buildId, rows: firstRows, count } = initial;

    // Small boards: the SSR page's own rows already cover every posting.
    if (count !== null && firstRows.length >= count) {
      return firstRows.map((r) => normalizeSenseHq(company, origin, r));
    }

    return paginate<NormalizedPosting>({
      provider: "sensehq",
      company: company.slug,
      pageSize: PAGE_SIZE,
      fetchPage: async (_offset, page) => {
        const json = await atsFetchJson(senseHqPageUrl(origin, buildId, page, PAGE_SIZE), { provider: "sensehq" });
        const parsedPage = senseHqPaginatedJobsData(json);
        if (!parsedPage) {
          if (page === 0) throw new Error(`sensehq: unexpected _next/data shape for ${company.slug}`);
          return { items: [], total: null };
        }
        return {
          items: parsedPage.rows.map((r) => normalizeSenseHq(company, origin, r)),
          total: parsedPage.count,
          rawCount: parsedPage.rows.length,
        };
      },
    });
  },
  // description_external carries the full JD inline — no fetchJd needed.
};
