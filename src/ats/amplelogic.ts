// src/ats/amplelogic.ts — AmpleLogic careers (www.amplelogic.com), a Next.js
// site whose jobs come from its own headless-CMS-backed API:
//
//   GET https://www.amplelogic.com/api/careers?locale=en
//     -> { data: [{ id: <slug>, publish: bool, translations: { en: {
//          title, department, location, type, experience, description,
//          responsibilities: [], requirements: [], niceToHave: [] } } }] }
//
// Verified live (2026-07-18, plain curl, no headers): single call, all
// postings (8, all "Hyderabad, India"), full JD fields inline, no
// pagination params observed. Only publish:true rows are surfaced.
import { z } from "zod";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { makeJsonListAdapter } from "./json-list.js";
import { REMOTE_RE } from "./shared.js";

const LIST_URL = "https://www.amplelogic.com/api/careers?locale=en";
const BOARD_URL = "https://www.amplelogic.com/careers/";

const StrListSchema = z.array(z.string()).nullable().optional();

export const AmpleLogicEnSchema = z.object({
  title: z.string(),
  department: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  experience: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  responsibilities: StrListSchema,
  requirements: StrListSchema,
  niceToHave: StrListSchema,
});

export const AmpleLogicJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  publish: z.boolean().nullable().optional(),
  translations: z.object({ en: AmpleLogicEnSchema.nullable().optional() }).nullable().optional(),
});
export type AmpleLogicJob = z.infer<typeof AmpleLogicJobSchema>;

export const AmpleLogicResponseSchema = z.object({ data: z.array(AmpleLogicJobSchema) });

export function normalizeAmpleLogicJob(
  company: AdapterCompany,
  j: AmpleLogicJob,
): NormalizedPosting | null {
  const en = j.translations?.en;
  if (!en?.title) return null;
  const jdParts = [
    en.description ?? "",
    ...(en.responsibilities ?? []),
    ...(en.requirements ?? []),
    ...(en.niceToHave ?? []),
  ].filter(Boolean);
  const location = en.location?.trim() || null;
  return {
    provider: "amplelogic",
    externalId: String(j.id),
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: en.title,
    jobUrl: BOARD_URL,
    location,
    isRemote: location ? REMOTE_RE.test(location) : false,
    jdText: jdParts.join("\n"),
    postedAt: null,
  };
}

export const amplelogicAdapter = makeJsonListAdapter({
  provider: "amplelogic",
  url: () => LIST_URL,
  schema: AmpleLogicResponseSchema,
  items: (parsed) => parsed.data,
  keep: (j) => j.publish !== false,
  normalize: normalizeAmpleLogicJob,
});
