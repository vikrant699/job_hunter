import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson } from "./http.js";
import { REMOTE_RE } from "./shared.js";

// Greenhouse public board API: GET boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true
const GhJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  updated_at: z.string().nullable().optional(),
  absolute_url: z.string().url(),
  location: z
    .object({ name: z.string().nullable().optional() })
    .nullable()
    .optional(),
  content: z.string().nullable().optional(),
});
type GhJob = z.infer<typeof GhJobSchema>;

const GhJobsResponseSchema = z.object({
  jobs: z.array(GhJobSchema),
});

export const greenhouseAdapter: AtsAdapter = {
  provider: "greenhouse",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const slug = company.slug;
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;

    const raw = await atsFetchJson(url, { provider: "greenhouse" });

    const parsed = GhJobsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ slug, issues: parsed.error.issues.slice(0, 3) }, "greenhouse schema mismatch");
      throw new Error(`greenhouse response failed schema for ${slug}`);
    }

    return parsed.data.jobs.map((j) => normalize(company, j));
  },
};

function normalize(company: AdapterCompany, j: GhJob): NormalizedPosting {
  const locationName = j.location?.name ?? null;
  const jdText = htmlToText(j.content ?? "");
  const isRemote = locationName ? REMOTE_RE.test(locationName) : false;

  return {
    provider: "greenhouse",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: j.absolute_url,
    location: locationName,
    isRemote,
    jdText,
    postedAt: j.updated_at ?? null,
  };
}
