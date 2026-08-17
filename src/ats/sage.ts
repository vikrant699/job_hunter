// src/ats/sage.ts — Sage Group careers (sage.com); also carries ex-Fyle roles (Fyle was acquired by Sage, no separate board exists for them).
// GET .../GetCareerSearchData/ returns the full global vacancy list with no pagination; India filtering happens client-side in the browser, replicated here.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, dateToIso } from "./shared.js";

const LIST_URL = "https://www.sage.com/api/sagedotcom/CareerSearch/GetCareerSearchData/";

export const SageRecordSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Function: z.string().nullable().optional(),
  Description: z.string().nullable().optional(),
  Url: z.string(),
  OfficeLocation: z.string().nullable().optional(),
  Country: z.string().nullable().optional(),
  ActiveDate: z.string().nullable().optional(),
});
export type SageRecord = z.infer<typeof SageRecordSchema>;

const SageResponseSchema = z.object({
  vacancies: z.object({
    TotalSize: z.number().nullable().optional(),
    Records: z.array(SageRecordSchema),
  }),
});

/** Client-side India filter — the API itself always returns every country. */
export function filterIndiaSage(records: SageRecord[]): SageRecord[] {
  return records.filter((r) => r.Country?.toLowerCase() === "india");
}

export function normalizeSage(company: AdapterCompany, r: SageRecord): NormalizedPosting {
  const location = r.OfficeLocation ?? null;
  return {
    provider: "sage",
    externalId: r.Id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.Name,
    jobUrl: r.Url,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: r.Description ?? "",
    postedAt: dateToIso(r.ActiveDate),
  };
}

export const sageAdapter: AtsAdapter = {
  provider: "sage",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(LIST_URL, { provider: "sage" });
    const parsed = parseOrThrow(SageResponseSchema, raw, { provider: "sage", slug: company.slug });
    const india = filterIndiaSage(parsed.vacancies.Records);
    return india.map((r) => normalizeSage(company, r));
  },
  // Description is already plain text in the list response — no fetchJd needed.
};
