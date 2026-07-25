// src/ats/gullak.ts — Gullak Money careers ("AutoHire", Gullak's in-house
// recruiting SPA at candid.hub.gullak.money, which gullak.money/careers
// redirects to):
//
//   GET https://autohire.internal.svc.uat.glkmny.tech/public/jobs
//     -> { pipelines: [{ id, name, description, experience_required,
//          jd_link, status }] }
//
// Verified live (2026-07-18, plain curl, no auth) — the "internal"/"uat"
// hostname is publicly reachable (glkmny.tech is Gullak's own domain) but
// FRAGILE by naming convention; schema failures here should be treated as
// "endpoint rotated", not parse drift. Only status === "active" pipelines
// are live postings. The full JD is an external Google Drive file per role
// (jd_link) — not fetchable as text — so jdText uses the inline description
// + experience fields. No location field exists; Gullak is a Bengaluru
// fintech, so a fixed India location is stamped.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";

const LIST_URL = "https://autohire.internal.svc.uat.glkmny.tech/public/jobs";
const BOARD_URL = "https://candid.hub.gullak.money/jobs/";
const FIXED_LOCATION = "Bengaluru, India";

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
      if (j.status && j.status !== "active") continue;
      const p = normalizeGullakJob(company, j);
      if (seen.has(p.externalId)) continue;
      seen.add(p.externalId);
      out.push(p);
    }
    return out;
  },
};
