// list: GET .../public/jobs -> { pipelines: [...] }, no auth
// host ("internal"/"uat" naming) is fragile — a schema failure here likely means the endpoint rotated
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";

const LIST_URL = "https://autohire.internal.svc.uat.glkmny.tech/public/jobs";
const BOARD_URL = "https://candid.hub.gullak.money/jobs/";
const FIXED_LOCATION = "Bengaluru, India"; // no location field on the API

export const GullakJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  description: z.string().nullable().optional(),
  experience_required: z.union([z.string(), z.number()]).nullable().optional(),
  jd_link: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type GullakJob = z.infer<typeof GullakJobSchema>;

export const GullakResponseSchema = z.object({ pipelines: z.array(GullakJobSchema) });

export function normalizeGullakJob(company: AdapterCompany, j: GullakJob): NormalizedPosting {
  // jd_link is an external Google Drive link (unfetchable), so jdText is built from description+experience instead.
  const jdText = [
    j.description ?? "",
    j.experience_required !== null && j.experience_required !== undefined
      ? `Experience required: ${j.experience_required}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    provider: "gullak",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.name,
    jobUrl: BOARD_URL,
    location: FIXED_LOCATION,
    isRemote: false,
    jdText,
    postedAt: null,
  };
}

export const gullakAdapter: AtsAdapter = {
  provider: "gullak",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(LIST_URL, { provider: "gullak" });
    const parsed = parseOrThrow(GullakResponseSchema, raw, {
      provider: "gullak",
      slug: company.slug,
      what: "list (their UAT host may have rotated)",
    });
    const out: NormalizedPosting[] = [];
    const seen = new Set<string>();
    for (const j of parsed.pipelines) {
      if (j.status && j.status !== "active") continue; // only active pipelines are live postings
      const p = normalizeGullakJob(company, j);
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }
    return out;
  },
};
