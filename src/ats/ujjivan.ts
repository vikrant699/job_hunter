// src/ats/ujjivan.ts — Ujjivan Small Finance Bank careers, a first-party JSON
// API on the bank's own site (no auth):
//   GET https://www.ujjivansfb.bank.in/api/jobs
//     -> { success, count, data: [{ job_id, job_title, department,
//          business_unit, location: [string], location_city: [string],
//          location_country, description|job_description (HTML) }] }
// One GET returns all ~226 postings. Many are multi-branch banking roles with
// a large location[] array (branch list).
//
// JD: the list API USED to inline description/job_description, but the bank's
// 2026 site redesign dropped both fields from the list payload (every posting
// stored as no-jd for weeks). The JD now lives on a detail endpoint that is
// only discoverable in the site's JS bundle:
//   POST https://www.ujjivansfb.bank.in/api/jobs/job-details  {"job_id": id}
//     -> { data: { data: { job_decription: "<html>" } } }
// — yes, `job_decription`, the bank misspelled their own field (verified live
// 2026-08-13, 41k-char JDs). We read the correctly-spelled variants too in
// case they ever fix it.
import { z } from "zod";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { BROWSER_UA } from "../util/userAgent.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { makeJsonListAdapter } from "./jsonList.js";
import { REMOTE_RE } from "./shared.js";
import type { AtsAdapter } from "./types.js";

const LIST_URL = "https://www.ujjivansfb.bank.in/api/jobs";
const DETAIL_URL = "https://www.ujjivansfb.bank.in/api/jobs/job-details";
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

export const UjjivanDetailSchema = z.object({
  data: z.object({
    data: z.object({
      /** The bank's own (misspelled) field name; correct spellings accepted
       *  defensively in case they ever fix it. */
      job_decription: z.string().nullable().optional(),
      job_description: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
  }),
});

export const ujjivanAdapter: AtsAdapter = {
  ...makeJsonListAdapter({
    provider: "ujjivan",
    url: () => LIST_URL,
    schema: UjjivanResponseSchema,
    items: (parsed) => parsed.data,
    normalize: normalizeUjjivan,
    userAgent: BROWSER_UA,
  }),

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(DETAIL_URL, {
      provider: "ujjivan",
      userAgent: BROWSER_UA,
      body: { job_id: posting.externalId },
    });
    const parsed = parseOrThrow(UjjivanDetailSchema, raw, {
      provider: "ujjivan",
      slug: posting.companySlug,
      what: `job-details ${posting.externalId}`,
    });
    const d = parsed.data.data;
    return htmlToText(d.job_decription ?? d.job_description ?? d.description ?? "");
  },
};
