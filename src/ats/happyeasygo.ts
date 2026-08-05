// src/ats/happyeasygo.ts — HappyEasyGo (single-company, static-JWT-free JSON API).
// GET https://www.happyeasygo.com/heg_api/join/getDepartmentJobList.do returns
// { code: 0, succ: true, data: [<department>], token, noteInfo }. Each department
// is mostly-null at the top level; the actual open positions live nested in its
// `joinUsMessages` array (fields: id, position, workPlace, jobDescription,
// workRequirements, createTime, ...). We flatten every department's
// joinUsMessages into one posting list. HappyEasyGo is Gurugram-based and every
// live position observed carries workPlace "Gurugram" — we still fall back to a
// constant "Gurugram, India" for the rare null case rather than dropping location.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE, epochMsToIso } from "./shared.js";
import { BROWSER_UA } from "../util/userAgent.js";

const LIST_URL = "https://www.happyeasygo.com/heg_api/join/getDepartmentJobList.do";
const CAREERS_URL = "https://www.happyeasygo.com/Careers/";
// Company HQ; used only when a position's workPlace is null (none observed live,
// but the field is nullable in the API so we don't want a blank location).
const DEFAULT_LOCATION = "Gurugram, India";

const PositionSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable().optional(),
  departmentId: z.union([z.string(), z.number()]).nullable().optional(),
  position: z.string().nullable().optional(),
  workPlace: z.string().nullable().optional(),
  jobDescription: z.string().nullable().optional(),
  workRequirements: z.string().nullable().optional(),
  createTime: z.number().nullable().optional(),
});
export type HappyEasyGoPosition = z.infer<typeof PositionSchema>;

const DepartmentSchema = z.object({
  departmentId: z.union([z.string(), z.number()]).nullable().optional(),
  departmentName: z.string().nullable().optional(),
  joinUsMessages: z.array(PositionSchema).nullable().optional(),
});
export type HappyEasyGoDepartment = z.infer<typeof DepartmentSchema>;

const ListSchema = z.object({
  code: z.number().nullable().optional(),
  succ: z.boolean().nullable().optional(),
  data: z.array(DepartmentSchema),
});

/**
 * Flatten one department's joinUsMessages into normalized postings.
 * `deptIndex` feeds the externalId fallback when a position is missing its own
 * `id` (departmentId + its index within the department, which is stable across
 * fetches since positions are only appended, never reordered, in the observed
 * payload).
 */
export function flattenDepartment(company: AdapterCompany, dept: HappyEasyGoDepartment): NormalizedPosting[] {
  const positions = dept.joinUsMessages ?? [];
  return positions.map((p, i) => normalizeHappyEasyGo(company, p, dept, i));
}

export function normalizeHappyEasyGo(
  company: AdapterCompany,
  p: HappyEasyGoPosition,
  dept: HappyEasyGoDepartment,
  indexInDept: number,
): NormalizedPosting {
  const externalId = p.id != null ? String(p.id) : `${dept.departmentId ?? "dept"}-${indexInDept}`;
  const location = (p.workPlace && p.workPlace.trim()) || DEFAULT_LOCATION;
  const jdParts = [p.jobDescription, p.workRequirements].filter((s): s is string => Boolean(s && s.trim()));
  return {
    provider: "happyeasygo",
    externalId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: p.position ?? "",
    // SPA careers page has no per-job routes — every listing points at the same URL.
    jobUrl: CAREERS_URL,
    location,
    isRemote: REMOTE_RE.test(location),
    jdText: htmlToText(jdParts.join("\n\n")),
    // createTime is already a millisecond epoch (13-digit, e.g. 1547475963000),
    // unlike Workday's seconds-based fields that `unixToIso` targets.
    postedAt: epochMsToIso(p.createTime),
  };
}

export const happyeasygoAdapter: AtsAdapter = {
  provider: "happyeasygo",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(LIST_URL, { provider: "happyeasygo", userAgent: BROWSER_UA });
    const parsed = parseOrThrow(ListSchema, raw, { provider: "happyeasygo", slug: company.slug });
    if (parsed.succ === false || parsed.data.length === 0) {
      throw new Error(`happyeasygo: empty/unsuccessful department list for ${company.slug}`);
    }
    const out: NormalizedPosting[] = [];
    for (const dept of parsed.data) out.push(...flattenDepartment(company, dept));
    return out;
  },
  // The list response carries the full description — no fetchJd needed.
};
