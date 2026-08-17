// src/ats/squareyards.ts — Square Yards careers, a department-scoped JSON endpoint (GET /career/<Department>); there is no single "all departments" endpoint (that path serves the React shell instead), so listPostings iterates a fixed department list and skips (logged) any that 404 or return non-JSON.
// No per-job URL field is returned; the real detail page is /career_form/<id>?location=&dept= - the /career/<Department> API paths themselves serve JSON even to a browser, so they must never be used as jobUrl.
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

// API department slugs from the careers page's tab JS (client-rendered, not discoverable via one call) - a wrong/short-form slug returns an empty data array rather than an error, so it silently drops jobs.
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

/** Unwrap one department page's job list. Never throws - a malformed/non-JSON response yields [] so the caller can skip the department instead of failing the whole board. */
export function squareyardsJobsFrom(raw: JsonValue): JsonValue[] {
  const parsed = SquareYardsResponseSchema.safeParse(raw);
  return parsed.success ? (parsed.data.data ?? []) : [];
}

/** The human-viewable per-job page, matching the careers UI's "Apply Now" target (numeric `id`, not `jobId`; spaces in params underscored). */
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
