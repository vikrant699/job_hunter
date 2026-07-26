// src/ats/skuad.ts — Skuad careers (www.skuad.io/careers), a Webflow site
// whose job list comes from a Google Apps Script web app (Sheet-backed; the
// exec URL is baked into Skuad's own JS bundle):
//
//   GET https://script.google.com/macros/s/<DEPLOYMENT>/exec
//     -> { job_roles: [], ..., data: [{ job_role, job_categories, job_type,
//          location, date_posted, no_of_days, experience, department,
//          apply_link, country_flag }] }
//
// Verified live (2026-07-18, plain curl, follows the googleusercontent echo
// redirect, no auth). No pagination — the site slices client-side. There is
// NO JD text anywhere on skuad.io: apply_link points to a third-party board
// (allremote.jobs). jdText is synthesized from the structured fields so the
// posting is still gate-able; the apply_link is kept as jobUrl.
import { z } from "zod";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { makeJsonListAdapter } from "./json-list.js";
import { REMOTE_RE } from "./shared.js";

const LIST_URL =
  "https://script.google.com/macros/s/AKfycbzogLvHCtVVrcB3iYVJhxU0jQuOxzTb1z1SD4eZcvA_0lskFnEXUyAYbT8QwN1KIcmk/exec";
const BOARD_URL = "https://www.skuad.io/careers";

export const SkuadJobSchema = z.object({
  job_role: z.string(),
  job_categories: z.string().nullable().optional(),
  job_type: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  date_posted: z.string().nullable().optional(),
  experience: z.union([z.string(), z.number()]).nullable().optional(),
  department: z.string().nullable().optional(),
  apply_link: z.string().nullable().optional(),
});
export type SkuadJob = z.infer<typeof SkuadJobSchema>;

export const SkuadResponseSchema = z.object({ data: z.array(SkuadJobSchema) });

export function normalizeSkuadJob(company: AdapterCompany, j: SkuadJob): NormalizedPosting {
  const location = j.location?.trim() || null;
  const jdText = [
    j.department ? `Department: ${j.department}` : "",
    j.job_categories ? `Category: ${j.job_categories}` : "",
    j.job_type ? `Type: ${j.job_type}` : "",
    j.experience !== null && j.experience !== undefined ? `Experience: ${j.experience}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    provider: "skuad",
    // No server id exists — the role+location pair is the only stable key.
    externalId: `${j.job_role}::${location ?? ""}`.toLowerCase().replace(/[^a-z0-9:]+/g, "-"),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.job_role,
    jobUrl: j.apply_link?.trim() || BOARD_URL,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText,
    postedAt: null,
  };
}

export const skuadAdapter = makeJsonListAdapter({
  provider: "skuad",
  url: () => LIST_URL,
  schema: SkuadResponseSchema,
  items: (parsed) => parsed.data,
  normalize: normalizeSkuadJob,
});
