// src/ats/ujjivan.ts — Ujjivan SFB careers: GET www.ujjivansfb.bank.in/api/jobs -> { data: [...] }, no auth, one page returns all ~226 postings (many multi-branch with large location[] arrays).
// JD: the list payload dropped description fields in the bank's 2026 site redesign; fetchJd calls POST .../api/jobs/job-details {job_id} -> job_decription in the response.
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
      // The bank's own (misspelled) field name; correct spellings accepted defensively.
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
