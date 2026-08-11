// src/ats/squareyards.ts — Square Yards careers (real estate), a
// department-scoped in-house JSON endpoint:
//   GET https://www.squareyards.com/career/<Department>
//     -> { status, message, data: [ { id, jobId, positionName, location,
//          description (HTML), status, postedOn, department, ... } ] }
// There is no single "all departments" JSON endpoint — GET /career with no
// department returns the React shell (HTML), not JSON — so listPostings
// iterates a fixed department list and concatenates. A department that 404s
// or returns non-JSON is skipped (logged) rather than failing the whole
// board. JD is inline HTML in the list response; no fetchJd needed. The API
// gives no per-job URL field, but the careers page's own "Apply Now" button
// navigates to /career_form/<id>?location=<Loc>&dept=<Dept> (underscored),
// which is the only human-viewable per-job page — the /career/<Department>
// URLs themselves serve raw JSON in a browser, so they must never be used as
// jobUrl (verified 2026-08-11: they return application/json even for an HTML
// Accept header).
// Verified live 2026-08-01 (recounted 2026-08-11): Sales 22 jobs, Technology
// 7, Marketing 8, Human_Resources 1, Customer_Relations 1, Finance/Operations/
// General_Administration/Agent_Partner 0 (empty data: [], not an error).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { logger } from "../logger.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson } from "./http.js";
import { INTER_PAGE_DELAY_MS, REMOTE_RE, joinLocation, sleep } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";
import type { JsonValue } from "../util/json.js";
import { JsonValueSchema } from "../util/json.js";

// The API department slugs the careers page's tab JS (carriers-*.min.js
// leftBoxTabClick) maps to, enumerated 2026-08-11. Not discoverable from a
// single JSON call — the nav is rendered client-side — so this is a manually
// maintained list. Note the tab labels alias to longer API slugs (HR ->
// Human_Resources, CR -> Customer_Relations, ...); the short forms return an
// empty data array rather than an error, so a wrong slug silently drops jobs.
export const SQUAREYARDS_DEPARTMENTS = [
  "Sales", "Technology", "Marketing", "Human_Resources", "Finance",
  "Operations", "General_Administration", "Customer_Relations", "Agent_Partner",
] as const;

export const SquareYardsJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jobId: z.string().nullable().optional(),
  positionName: z.string(),
  location: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  postedOn: z.string().nullable().optional(),
});
export type SquareYardsJob = z.infer<typeof SquareYardsJobSchema>;

const SquareYardsResponseSchema = z.object({
  status: z.number().optional(),
  message: z.string().optional(),
  data: z.array(JsonValueSchema).optional(),
});

/** URL for one department's job list. `origin` is the company's careers host. */
export function squareyardsDeptUrl(origin: string, department: string): string {
  return `${origin}/career/${department}`;
}

/** Unwrap one department page's job list. Never throws — a malformed or
 *  non-JSON (e.g. HTML shell) response yields [] so the caller can skip the
 *  department instead of failing the whole board. */
export function squareyardsJobsFrom(raw: JsonValue): JsonValue[] {
  const parsed = SquareYardsResponseSchema.safeParse(raw);
  return parsed.success ? (parsed.data.data ?? []) : [];
}

/** The human-viewable per-job page: where the careers UI's "Apply Now"
 *  navigates (`/career_form/<id>?location=<Loc>&dept=<Dept>`, spaces
 *  underscored). Uses the numeric `id` (not `jobId`); absent/blank params are
 *  omitted. */
export function squareyardsJobUrl(origin: string, department: string, j: SquareYardsJob): string {
  const params: string[] = [];
  if (j.location) params.push(`location=${j.location.split(" ").join("_")}`);
  const dept = j.department ?? department;
  if (dept) params.push(`dept=${dept.split(" ").join("_")}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${origin}/career_form/${String(j.id)}${query}`;
}

export function normalizeSquareYards(
  company: AdapterCompany,
  department: string,
  origin: string,
  j: SquareYardsJob,
): NormalizedPosting {
  const location = joinLocation(j.location);
  return {
    provider: "squareyards",
    externalId: j.jobId ?? String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.positionName,
    jobUrl: squareyardsJobUrl(origin, department, j),
    location,
    isRemote: location !== null && REMOTE_RE.test(location),
    jdText: htmlToText(j.description ?? ""),
    postedAt: j.postedOn ? j.postedOn : null,
  };
}

export const squareyardsAdapter: AtsAdapter = {
  provider: "squareyards",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const origin = new URL(company.careersUrl).origin;
    const seen = new Set<string>();
    const out: NormalizedPosting[] = [];

    for (const department of SQUAREYARDS_DEPARTMENTS) {
      const url = squareyardsDeptUrl(origin, department);
      let raw: JsonValue;
      try {
        raw = await atsFetchJson(url, { provider: "squareyards", userAgent: BROWSER_UA });
      } catch (err) {
        logger.warn(
          { slug: company.slug, department, err: err instanceof Error ? err.message : String(err) },
          "squareyards department fetch failed - skipping",
        );
        continue;
      }
      for (const r of squareyardsJobsFrom(raw)) {
        const parsed = SquareYardsJobSchema.safeParse(r);
        if (!parsed.success) continue;
        const posting = normalizeSquareYards(company, department, origin, parsed.data);
        if (seen.has(posting.externalId)) continue;
        seen.add(posting.externalId);
        out.push(posting);
      }
      await sleep(INTER_PAGE_DELAY_MS);
    }

    return out;
  },
};
