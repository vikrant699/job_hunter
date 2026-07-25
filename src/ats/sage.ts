// src/ats/sage.ts — Sage Group careers (sage.com), which now also carries the
// ex-Fyle Bangalore roles (Fyle was acquired by Sage in July 2025 and
// rebranded "Sage Expense Management"; fylehq.com/company/team/join is a
// static marketing page with zero embedded job listings — no board there,
// and the old fyle-team.freshteam.com tenant 500s).
//
// List: GET https://www.sage.com/api/sagedotcom/CareerSearch/GetCareerSearchData/
//   -> { vacancies: { TotalSize: number, Records: [{ Id, Name, Function,
//        Description (plain text, no HTML), Url, OfficeLocation, Country,
//        ActiveDate }] } }
//   This is Sage's own bespoke Kentico-Xperience-backed endpoint (not
//   Workday/Greenhouse/Lever/etc — confirmed by fingerprinting sage.com's
//   careers page network calls; the "Apply" link opens a Salesforce
//   fRecruit page, but that's not the listing/search channel). The call
//   takes no query params and always returns the FULL global vacancy list —
//   captured live: TotalSize == Records.length (163 == 163) — so there is no
//   pagination to drive; filtering by country/department happens client-side
//   in the browser only. The adapter replicates that client-side India filter
//   here so the one "sage" company row only yields India postings.
//
//   Ex-Fyle roles are identifiable within the shared list by their JD body
//   explicitly naming Fyle (e.g. "About Fyle (now part of Sage)" /
//   "Fyle is now part of Sage") — confirmed live on 2 of 6 India roles
//   (Frontend Architect, Principal Engineer, both Product Delivery/Bangalore).
//   No separate Fyle-only board exists, so this single "sage" adapter is the
//   one channel for both regular Sage India hiring and ex-Fyle hiring.
//
// JD: Description is already plain text (verified: 0/163 records contain any
//   HTML tags) — no fetchJd needed.
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
