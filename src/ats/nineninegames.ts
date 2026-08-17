// src/ats/nineninegames.ts — 99Games' careers board, a single-tenant custom CMS ("BackendCms") API.
// One unauthenticated GET (blogbackend.99games.in/BackendCms/jobOpportunities/opportunities) returns
// a bare JSON array with full HTML description inline, so no fetchJd. There is no per-job public URL
// (the board opens an in-page modal instead of navigating), so jobUrl is synthesized as the careers
// page plus a `#job-<id>` fragment.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, dateToIso } from "./shared.js";

const API_URL = "https://blogbackend.99games.in/BackendCms/jobOpportunities/opportunities";

export const NineNineGamesJobSchema = z.object({
  _id: z.string(),
  jobTitle: z.string(),
  jobLocation: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  publish: z.boolean().nullable().optional(),
  last_modified_on: z.string().nullable().optional(),
});
export type NineNineGamesJob = z.infer<typeof NineNineGamesJobSchema>;

const NineNineGamesListSchema = z.array(NineNineGamesJobSchema);

export function nineNineGamesShouldKeep(j: NineNineGamesJob): boolean {
  return j.publish !== false;
}

export function nineNineGamesJobUrl(company: AdapterCompany, id: string): string {
  return `${company.careersUrl.replace(/\/+$/, "")}#job-${id}`;
}

export function normalizeNineNineGamesJob(company: AdapterCompany, j: NineNineGamesJob): NormalizedPosting {
  const location = j.jobLocation ?? null;
  return {
    provider: "nineninegames",
    externalId: j._id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.jobTitle.trim(),
    jobUrl: nineNineGamesJobUrl(company, j._id),
    location,
    isRemote: REMOTE_RE.test(location ?? ""),
    jdText: htmlToText(j.description),
    // last_modified_on is a last-modified stamp, not created/posted, but it's the closest proxy available.
    postedAt: dateToIso(j.last_modified_on),
  };
}

export const nineNineGamesAdapter: AtsAdapter = {
  provider: "nineninegames",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(API_URL, { provider: "nineninegames" });
    const parsed = parseOrThrow(NineNineGamesListSchema, raw, { provider: "nineninegames", slug: company.slug });
    return parsed
      .filter(nineNineGamesShouldKeep)
      .map((j) => normalizeNineNineGamesJob(company, j));
  },
};
