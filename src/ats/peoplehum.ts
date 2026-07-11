// src/ats/peoplehum.ts — peopleHum shared career-site API (e.g. hire.peoplehum.com/<tenant>).
// Clean JSON list API: GET .../customer/<customerId>/external/job/list returns
// { responseObject: { content: Job[], ... }, status } with the FULL job
// description inline (both plain-text `description` and rich `descriptionHTML`).
// No pagination fields observed — treated as a flat list. `company.slug` is the
// numeric customerId (as a string); the public careers site is a client-rendered
// Angular SPA with no server-rendered per-job URL, so `jobUrl` falls back to the
// tenant's careers page for every posting.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

const PeoplehumLocationSchema = z.object({
  countryCity: z.string().nullable().optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  zipcode: z.string().nullable().optional(),
});

export const PeoplehumJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  descriptionHTML: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
  experience: z.string().nullable().optional(),
  isPrivate: z.union([z.boolean(), z.number()]).nullable().optional(),
  isRemote: z.boolean().nullable().optional(),
  location: z.array(PeoplehumLocationSchema).nullable().optional(),
  requestedDate: z.number().nullable().optional(),
  workPlaceType: z.string().nullable().optional(),
});
export type PeoplehumJob = z.infer<typeof PeoplehumJobSchema>;

const PeoplehumResponseSchema = z.object({
  responseObject: z.object({
    content: z.array(PeoplehumJobSchema),
  }),
});

export function peoplehumListUrl(company: AdapterCompany): string {
  return `https://webapi.peoplehum.com/api/web/internal-api/customer/${company.slug}/external/job/list`;
}

/** Unwrap `responseObject.content`; tolerant of a missing/empty envelope. */
export function peoplehumJobs(json: unknown): PeoplehumJob[] {
  return PeoplehumResponseSchema.parse(json).responseObject.content;
}

/** `isPrivate` has been observed as both `0`/`1` and boolean — normalize truthiness. */
export function isPeoplehumPrivate(j: PeoplehumJob): boolean {
  return Boolean(j.isPrivate);
}

export function normalizePeoplehum(company: AdapterCompany, j: PeoplehumJob): NormalizedPosting {
  const location = (j.location ?? [])
    .map((l) => l.countryCity)
    .filter((c): c is string => Boolean(c))
    .join("; ") || null;
  const postedMs = j.requestedDate ?? null;
  return {
    provider: "peoplehum",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: company.careersUrl,
    location,
    isRemote: Boolean(j.isRemote) || REMOTE_RE.test(`${j.workPlaceType ?? ""} ${location ?? ""}`),
    jdText: j.descriptionHTML ? htmlToText(j.descriptionHTML) : (j.description ?? ""),
    postedAt: postedMs != null ? new Date(postedMs).toISOString() : null,
  };
}

export const peoplehumAdapter: AtsAdapter = {
  provider: "peoplehum",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const json = await atsFetchJson(peoplehumListUrl(company), { provider: "peoplehum" });
    return peoplehumJobs(json)
      .filter((j) => !isPeoplehumPrivate(j))
      .map((j) => normalizePeoplehum(company, j));
  },
  // The list response carries the full description — no fetchJd needed.
};
