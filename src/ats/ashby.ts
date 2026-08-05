import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";

// Ashby public board: GET api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=false
const AshbyJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  location: z.string().nullable().optional(),
  secondaryLocations: z
    .array(z.object({ location: z.string() }))
    .nullable()
    .optional(),
  department: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  isRemote: z.boolean().nullable().optional(),
  descriptionHtml: z.string().nullable().optional(),
  descriptionPlain: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  jobUrl: z.string().url().nullable().optional(),
  applyUrl: z.string().url().nullable().optional(),
});
type AshbyJob = z.infer<typeof AshbyJobSchema>;

const AshbyResponseSchema = z.object({
  jobs: z.array(AshbyJobSchema),
});

export const ashbyAdapter: AtsAdapter = {
  provider: "ashby",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    // Ashby board name is usually our registry slug, but some orgs use a name
    // that can't be a registry slug (e.g. "monday.com") — apiMeta.boardSlug
    // overrides it, same pattern as tatacareers' apiMeta.company.
    const slug = company.apiMeta?.boardSlug ?? company.slug;
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`;

    const raw = await atsFetchJson(url, { provider: "ashby" });

    const parsed = parseOrThrow(AshbyResponseSchema, raw, { provider: "ashby", slug });
    return parsed.jobs.map((j) => normalize(company, j));
  },
};

function normalize(company: AdapterCompany, j: AshbyJob): NormalizedPosting {
  const primaryLoc = j.location ?? null;
  const secondary = (j.secondaryLocations ?? []).map((l) => l.location).join(", ");
  const location = secondary ? `${primaryLoc ?? ""}${primaryLoc ? "; " : ""}${secondary}`.trim() : primaryLoc;

  const jdText = j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? "");

  return {
    provider: "ashby",
    externalId: j.id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.jobUrl ?? j.applyUrl ?? "",
    location,
    isRemote: !!j.isRemote,
    jdText,
    postedAt: j.publishedAt ?? null,
  };
}
