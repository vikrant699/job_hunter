// list: POST jobOpenings.aspx/fetchJobOpenings {p_firm_id,...} -> {"d":"<json>"} .Data[] (whole board in one call, no pagination)
// jd: POST jobDescription.aspx/job_Description {P_FIRMID,P_MRF_ID} -> {"d":"<json>"} .Data[] (one row per qualification)
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { atsFetchJson, parseOrThrow } from "./http.js";
import { REMOTE_RE } from "./shared.js";
import { JsonValueSchema } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

const BASE = "https://hr.manappuram.com/macarrier/Views/HrOnBoarding/User";
export const MANAPPURAM_PORTAL_URL = `${BASE}/jobOpenings.aspx`;
export const MANAPPURAM_LIST_URL = `${BASE}/jobOpenings.aspx/fetchJobOpenings`;
export const MANAPPURAM_JD_URL = `${BASE}/jobDescription.aspx/job_Description`;
const DEFAULT_FIRM_ID = 296191;
const DAY_MS = 24 * 3600 * 1000;

const str = z.string().nullable().optional();
const num = z.number().nullable().optional();

const ListRowSchema = z.object({
  MRF_ID: z.number(),
  POSITION_NAME: z.string(),
  DESIGNATION_NAME: str,
  DEPT_NAME: str,
  SUB_DEPT_NAME: str,
  LOCATION: str,
  APPROVAL_DATE: str,
  POSTED_ON: num,
});
export type ManappuramRow = z.infer<typeof ListRowSchema>;

const DetailRowSchema = z.object({
  POSITION_NAME: str,
  DESIGNATION_NAME: str,
  DEPT_NAME: str,
  SUB_DEPT_NAME: str,
  VACANCY: num,
  EXPERIENCE: str,
  LOCATION: str,
  JOB_DESCRIPTION: str,
  RESPONSIBILITIES: str,
  SKILLS: str,
  QUALIFICATION: str,
});

const WrapperSchema = z.object({ d: z.string() });
const InnerSchema = z.object({ Status: z.number(), Message: str, Data: z.array(JsonValueSchema).nullable().optional() });

/** ASP.NET page methods double-encode: the body is {"d": "<json string>"} whose Status must be 200. */
function unwrap(raw: JsonValue, slug: string, what: string): JsonValue[] {
  const { d } = parseOrThrow(WrapperSchema, raw, { provider: "manappuram", slug, what });
  const inner = parseOrThrow(InnerSchema, JsonValueSchema.parse(JSON.parse(d)), { provider: "manappuram", slug, what });
  if (inner.Status !== 200) throw new Error(`manappuram ${what}: Status ${inner.Status} (${inner.Message ?? ""})`);
  return inner.Data ?? [];
}

export function parseManappuramList(raw: JsonValue, slug = "manappuram"): ManappuramRow[] {
  return unwrap(raw, slug, "list").map((r) => parseOrThrow(ListRowSchema, r, { provider: "manappuram", slug }));
}

// POSTED_DT is relative ("6 day(s) ago"); APPROVAL_DATE is the absolute posting date (IST, no zone) that POSTED_ON counts back to
export function manappuramPostedAt(r: ManappuramRow, now = Date.now()): string | null {
  const ymd = r.APPROVAL_DATE?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (ymd) return `${ymd}T00:00:00.000Z`;
  return r.POSTED_ON != null ? new Date(now - r.POSTED_ON * DAY_MS).toISOString() : null;
}

export function normalizeManappuram(company: AdapterCompany, r: ManappuramRow): NormalizedPosting {
  const branch = r.LOCATION?.trim();
  // bare branch names ("A.O.VALAPAD") the location filter can't place otherwise
  const location = branch ? `${branch}, India` : "India";
  const id = String(r.MRF_ID);
  return {
    provider: "manappuram",
    externalId: id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: r.POSITION_NAME.trim(),
    // the portal opens a job via sessionStorage, so there is no per-job URL
    jobUrl: `${MANAPPURAM_PORTAL_URL}#mrf-${id}`,
    location,
    isRemote: REMOTE_RE.test(location),
    jdText: "",
    postedAt: manappuramPostedAt(r),
  };
}

export function manappuramJdFromDetail(raw: JsonValue): string {
  let rows: Array<z.infer<typeof DetailRowSchema>>;
  try {
    rows = unwrap(raw, "manappuram", "detail").map((r) => DetailRowSchema.parse(r));
  } catch {
    return "";
  }
  const first = rows[0];
  if (!first) return "";
  const dept = [first.DEPT_NAME, first.SUB_DEPT_NAME].map((s) => s?.trim()).filter(Boolean);
  const quals = [...new Set(rows.map((r) => r.QUALIFICATION?.trim()).filter(Boolean))];
  const lines = [
    first.POSITION_NAME ? `Position: ${first.POSITION_NAME.trim()}` : "",
    dept.length ? `Department: ${[...new Set(dept)].join(" / ")}` : "",
    first.DESIGNATION_NAME ? `Grade: ${first.DESIGNATION_NAME.trim()}` : "",
    first.EXPERIENCE ? `Experience: ${first.EXPERIENCE.trim()} years` : "",
    first.LOCATION ? `Location: ${first.LOCATION.trim()}` : "",
    first.VACANCY != null ? `Vacancies: ${first.VACANCY}` : "",
    quals.length ? `Qualification: ${quals.join("; ")}` : "",
  ].filter(Boolean);
  const sections = [
    ["About the job", first.JOB_DESCRIPTION],
    ["Responsibilities", first.RESPONSIBILITIES],
    ["Skills", first.SKILLS],
  ] as const;
  const body = sections.flatMap(([h, v]) => (v?.trim() ? [`${h}:\n${v.trim()}`] : []));
  return body.length ? [lines.join("\n"), ...body].join("\n\n") : "";
}

function firmId(company: AdapterCompany): number {
  const v = Number(company.apiMeta?.firmId ?? DEFAULT_FIRM_ID);
  if (!Number.isInteger(v)) throw new Error(`manappuram: apiMeta.firmId is not an integer for ${company.slug}`);
  return v;
}

export const manappuramAdapter: AtsAdapter = {
  provider: "manappuram",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const raw = await atsFetchJson(MANAPPURAM_LIST_URL, {
      provider: "manappuram",
      body: { p_firm_id: firmId(company), p_searchtext: "", p_sort_id: 0, p_dept: "", p_state: "", p_dist: "", p_loc: "" },
    });
    return parseManappuramList(raw, company.slug).map((r) => normalizeManappuram(company, r));
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const raw = await atsFetchJson(MANAPPURAM_JD_URL, {
      provider: "manappuram",
      body: { P_FIRMID: firmId(company), P_MRF_ID: Number(posting.externalId) },
    });
    return manappuramJdFromDetail(raw);
  },
};
