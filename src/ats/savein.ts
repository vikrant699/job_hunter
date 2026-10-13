// list: GET cms.api.savein.money/web/careers/list -> { response[] }, one shot; job page = savein.money/career/job-details/<id>
// jd: inline (aboutTheRole + keyResponsibilities + skillsRequired HTML); India-only board with bare town names
import { z } from "zod";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { makeJsonListAdapter } from "./jsonList.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE, joinLocation } from "./shared.js";

const SaveinJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  location: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  dateOfPosting: z.string().nullable().optional(),
  aboutTheRole: z.string().nullable().optional(),
  keyResponsibilities: z.string().nullable().optional(),
  skillsRequired: z.string().nullable().optional(),
});
type SaveinJob = z.infer<typeof SaveinJobSchema>;

const SaveinResponseSchema = z.object({ response: z.array(SaveinJobSchema) });

function normalizeSavein(company: AdapterCompany, j: SaveinJob): NormalizedPosting {
  const place = j.location?.trim() || null;
  return {
    provider: "savein",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title.trim(),
    jobUrl: `https://savein.money/career/job-details/${encodeURIComponent(String(j.id))}`,
    location: place && !/\bindia\b/i.test(place) ? joinLocation(place, "India") : place,
    isRemote: place !== null && REMOTE_RE.test(place),
    jdText: [j.aboutTheRole, j.keyResponsibilities, j.skillsRequired].map((s) => htmlToText(s ?? "")).filter(Boolean).join("\n\n"),
    postedAt: j.dateOfPosting ?? null,
  };
}

export const saveinAdapter = makeJsonListAdapter({
  provider: "savein",
  url: () => "https://cms.api.savein.money/web/careers/list",
  schema: SaveinResponseSchema,
  items: (parsed) => parsed.response,
  keep: (j) => !j.status || j.status.toUpperCase() === "ACTIVE",
  normalize: normalizeSavein,
});
