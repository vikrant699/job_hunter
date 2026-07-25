// src/ats/bajajauto.ts — Bajaj Auto careers, a custom in-house ASP.NET handler
// on the corporate site (no auth):
//   GET https://www.bajajauto.com/handlers/careers/get-requisitions.ashx
//     -> { jobRequisitions: [{ jobReqId, jobTitle, jobUrl (slug),
//          jobDescription (HTML JD), country, State, location, custCity }] }
// One GET returns all ~207 requisitions (India). JD inline. Verified live
// 2026-07-18.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { BROWSER_UA } from "../util/user-agent.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const LIST_URL = "https://www.bajajauto.com/handlers/careers/get-requisitions.ashx";
const BOARD = "https://www.bajajauto.com/careers/why-us";

export const BajajAutoJobSchema = z.object({
  jobReqId: z.union([z.string(), z.number()]),
  jobTitle: z.string(),
  jobUrl: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  State: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  custCity: z.string().nullable().optional(),
  createdDateTime: z.string().nullable().optional(),
});
export type BajajAutoJob = z.infer<typeof BajajAutoJobSchema>;
export const BajajAutoResponseSchema = z.object({ jobRequisitions: z.array(BajajAutoJobSchema) });

export function normalizeBajajAuto(company: AdapterCompany, j: BajajAutoJob): NormalizedPosting {
  const location =
    [j.custCity || j.location, j.State, j.country].map((s) => (s ?? "").trim()).filter(Boolean).join(", ") || null;
  return {
    provider: "bajajauto",
    externalId: String(j.jobReqId),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle,
    jobUrl: j.jobUrl ? `${BOARD}?job=${encodeURIComponent(j.jobUrl)}` : BOARD,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: htmlToText(j.jobDescription ?? ""),
    postedAt: j.createdDateTime ?? null,
  };
}

export const bajajautoAdapter: AtsAdapter = {
  provider: "bajajauto",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(LIST_URL, { provider: "bajajauto", userAgent: BROWSER_UA });
    const parsed = parseOrThrow(BajajAutoResponseSchema, raw, { provider: "bajajauto", slug: company.slug });
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const j of parsed.jobRequisitions) {
      const p = normalizeBajajAuto(company, j);
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }
    return out;
  },
};
