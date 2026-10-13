// list: GET app.reczee.com/api/v1/requisitions/get-open-requisitions?company_slug=<slug> -> data.requisitions[], one shot (unknown slug 404s, a live empty tenant returns [])
// jd: inline (job_description HTML); job page = jobs.reczee.com/<slug>/<requisition slug>/apply
import { z } from "zod";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { makeJsonListAdapter } from "./jsonList.js";
import { htmlToText } from "./htmlText.js";
import { REMOTE_RE, joinLocation } from "./shared.js";

const ReczeeLocationSchema = z.object({
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

const ReczeeRequisitionSchema = z.object({
  id: z.union([z.number(), z.string()]),
  slug: z.string().min(1),
  title: z.string().nullable().optional(),
  designation: z.string().nullable().optional(),
  job_description: z.string().nullable().optional(),
  locations: z.array(ReczeeLocationSchema).nullable().optional(),
  posted_on: z.string().nullable().optional(),
});
type ReczeeRequisition = z.infer<typeof ReczeeRequisitionSchema>;

const ReczeeResponseSchema = z.object({
  data: z.object({ requisitions: z.array(ReczeeRequisitionSchema) }),
});

export function reczeeListUrl(company: AdapterCompany): string {
  return `https://app.reczee.com/api/v1/requisitions/get-open-requisitions?company_slug=${encodeURIComponent(company.slug)}`;
}

function normalizeReczee(company: AdapterCompany, r: ReczeeRequisition): NormalizedPosting | null {
  const title = (r.title ?? "").trim() || (r.designation ?? "").trim();
  if (!title) return null;
  const location = (r.locations ?? []).map((l) => joinLocation(l.city, l.country)).filter((l) => l !== null).join("; ") || null;
  return {
    provider: "reczee",
    externalId: String(r.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: title,
    jobUrl: `https://jobs.reczee.com/${encodeURIComponent(company.slug)}/${encodeURIComponent(r.slug)}/apply`,
    location,
    isRemote: location !== null && REMOTE_RE.test(location),
    jdText: htmlToText(r.job_description ?? ""),
    postedAt: r.posted_on ?? null,
  };
}

export const reczeeAdapter = makeJsonListAdapter({
  provider: "reczee",
  url: reczeeListUrl,
  schema: ReczeeResponseSchema,
  items: (parsed) => parsed.data.requisitions,
  normalize: normalizeReczee,
});
