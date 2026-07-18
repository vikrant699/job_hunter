// src/ats/ujjivan.ts — Ujjivan Small Finance Bank careers, a first-party JSON
// API on the bank's own site (no auth):
//   GET https://www.ujjivansfb.bank.in/api/jobs
//     -> { success, count, data: [{ job_id, job_title, department,
//          business_unit, location: [string], location_city: [string],
//          location_country, description|job_description (HTML) }] }
// One GET returns all ~226 postings. Many are multi-branch banking roles with
// a large location[] array (branch list). JD inline. Verified live 2026-07-18.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const LIST_URL = "https://www.ujjivansfb.bank.in/api/jobs";
const BOARD = "https://www.ujjivansfb.bank.in/careers";

export const UjjivanJobSchema = z.object({
  job_id: z.union([z.string(), z.number()]),
  job_title: z.string(),
  department: z.string().nullable().optional(),
  business_unit: z.string().nullable().optional(),
  location: z.array(z.string()).nullable().optional(),
  location_city: z.array(z.string()).nullable().optional(),
  description: z.string().nullable().optional(),
  job_description: z.string().nullable().optional(),
});
export type UjjivanJob = z.infer<typeof UjjivanJobSchema>;
export const UjjivanResponseSchema = z.object({ data: z.array(UjjivanJobSchema) });

export function normalizeUjjivan(company: AdapterCompany, j: UjjivanJob): NormalizedPosting {
  const cities = (j.location_city ?? []).map((s) => s.trim()).filter(Boolean);
  const uniq = [...new Set(cities)];
  // Branch roles list dozens of cities; keep it readable but India-tagged.
  const location = uniq.length > 0 ? `${uniq.slice(0, 8).join(", ")}${uniq.length > 8 ? " …" : ""}, India` : "India";
  return {
    provider: "ujjivan",
    externalId: String(j.job_id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.job_title,
    jobUrl: `${BOARD}#${j.job_id}`,
    location,
    isRemote: REMOTE_RE.test(location),
    jdText: htmlToText(j.description ?? j.job_description ?? ""),
    postedAt: null,
  };
}

export const ujjivanAdapter: AtsAdapter = {
  provider: "ujjivan",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(LIST_URL, { provider: "ujjivan", userAgent: BROWSER_UA });
    const parsed = UjjivanResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ slug: company.slug, issues: parsed.error.issues.slice(0, 3) }, "ujjivan schema mismatch");
      throw new Error(`ujjivan response failed schema for ${company.slug}`);
    }
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const j of parsed.data.data) {
      const p = normalizeUjjivan(company, j);
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }
    return out;
  },
};
