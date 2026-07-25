// src/ats/magicpin.ts — magicpin's careers board (magicpin.in/careers).
//
// Single-tenant, not a multi-company ATS platform: everything below is
// hardcoded to this one company's own hand-rolled API, not derived from
// `company.tenantUrl`/`company.apiMeta` the way multi-tenant adapters are.
//
// The careers page is a Next.js SPA — jobs are NOT in the initial HTML, they
// load client-side from a separate API host. Traced from the page's network
// traffic and its `_next/static/chunks/4674-*.js` bundle (2026-07):
//
//   - The jobs API lives on a DIFFERENT host than the careers page itself:
//     https://sales.magicpin.in/magickiosk/career/jobs (not magicpin.in/api/...
//     — that path 400s/"Empty token"s because it's an unrelated endpoint).
//   - Auth is a single hardcoded bearer JWT, baked directly into the bundle
//     as the default header of the page's shared axios instance:
//       `n.n(r)().create({headers:{"Content-Type":"application/json",
//        Authorization:"Bearer eyJhbGc...")}})`
//     It is STATIC, not session-issued: no `exp` claim, `iat` is a 2022-12-22
//     timestamp, and it decodes to a generic service identity
//     (`{"id":"...","username":"Judge_Cronin","iat":1671697171}`) — not a
//     per-visit token from an init/auth call. Confirmed by hitting the API
//     with a bare `curl`/`fetch` (no browser, no cookies) using only this
//     header: 200 OK, `access-control-allow-origin: *`. If magicpin ever
//     rotates it, re-grep a fresh `4674-*.js`-equivalent chunk for
//     `Authorization:"Bearer ` to find the new literal.
//
// Endpoints (confirmed live 2026-07-11):
//   GET https://sales.magicpin.in/magickiosk/career/jobs
//     -> [{ _id: <department slug>, count, jobs: [{ _id, title, experience,
//          location, employmentType }] }, ...]
//     The real SPA also sends `?search=&department=&location=&experience=
//     &employmentType=` (all null by default = no filter); omitting them
//     entirely returns the same unfiltered full set. No pagination — every
//     open role across every department comes back in one response.
//   GET https://sales.magicpin.in/magickiosk/career/jobs/<jobId>
//     -> { _id, department, title, requirements: "<html>", responsibilities:
//          "<plain text, often empty>", ... }
//     The list endpoint carries no JD body, so `fetchJd` re-fetches this per
//     posting and concatenates `requirements` + `responsibilities`.
//
// The public job-detail page (linked from the board) is
//   https://magicpin.in/careers/jobdescription?jobId=<jobId>
// (route + query param name traced from the careers bundle's onClick
// handler: `router.push("/careers/jobdescription?jobId=" + job._id)`).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrNull } from "./http.js";
import { REMOTE_RE } from "./shared.js";

// Single-tenant: this is magicpin's own site, not a SaaS ATS host pattern.
const API_BASE = "https://sales.magicpin.in/magickiosk/career";
const LIST_URL = `${API_BASE}/jobs`;
const jdUrl = (jobId: string): string => `${API_BASE}/jobs/${encodeURIComponent(jobId)}`;
const jobPageUrl = (jobId: string): string =>
  `https://magicpin.in/careers/jobdescription?jobId=${encodeURIComponent(jobId)}`;

// See the module header for provenance. Read from a constant so a future
// rotation is a one-line patch: re-grep a fresh bundle for `Authorization:"Bearer `.
const STATIC_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjYzYTNmOTI0NTNjODViYzEyNjU4ZjNiZSIsInVzZXJuYW1lIjoiSnVkZ2VfQ3JvbmluIiwiaWF0IjoxNjcxNjk3MTcxfQ.hbZLKSsS6Mdj1ndhAf4rm_5we4iWYvKY1VPSo51sQRM";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${STATIC_TOKEN}` };
}

export const MagicpinListJobSchema = z.object({
  _id: z.string(),
  title: z.string(),
  experience: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  employmentType: z.string().nullable().optional(),
});
export type MagicpinListJob = z.infer<typeof MagicpinListJobSchema>;

const MagicpinDeptGroupSchema = z.object({
  _id: z.string(),
  count: z.number().nullable().optional(),
  jobs: z.array(MagicpinListJobSchema),
});

const MagicpinListResponseSchema = z.array(MagicpinDeptGroupSchema);

/** Flatten the department-grouped `[].jobs[]` into one job array. */
export function flattenMagicpinJobs(raw: unknown): MagicpinListJob[] {
  const parsed = MagicpinListResponseSchema.parse(raw);
  return parsed.flatMap((group) => group.jobs);
}

const MagicpinDetailSchema = z.object({
  _id: z.string(),
  requirements: z.string().nullable().optional(),
  responsibilities: z.string().nullable().optional(),
});

export function normalizeMagicpin(company: AdapterCompany, j: MagicpinListJob): NormalizedPosting {
  return {
    provider: "magicpin",
    externalId: j._id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.title,
    jobUrl: jobPageUrl(j._id),
    location: j.location ?? null,
    isRemote: REMOTE_RE.test(j.location ?? ""),
    jdText: "", // list endpoint carries no JD body; fetchJd hits the detail endpoint.
    postedAt: null, // neither list nor detail response carries a reliable posting date.
  };
}

/**
 * Extract + flatten the JD body from a job detail response. `requirements`
 * (HTML, sometimes an empty `<p><br></p>`) and `responsibilities` (plain
 * text, sometimes empty) are both populated inconsistently across postings —
 * concatenate whichever are non-empty after HTML-stripping.
 */
export function magicpinJdFromDetail(detailJson: unknown, ctx: { slug: string; jobId: string }): string {
  const parsed = parseOrNull(MagicpinDetailSchema, detailJson, {
    provider: "magicpin",
    slug: ctx.slug,
    what: `detail ${ctx.jobId}`,
  });
  if (!parsed) return "";
  const parts = [parsed.requirements, parsed.responsibilities]
    .map((s) => htmlToText(s))
    .filter((s) => s.length > 0);
  return parts.join("\n\n");
}

export const magicpinAdapter: AtsAdapter = {
  provider: "magicpin",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const json = await atsFetchJson(LIST_URL, { provider: "magicpin", headers: authHeaders() });
    const jobs = flattenMagicpinJobs(json);
    return jobs.map((j) => normalizeMagicpin(company, j));
  },

  async fetchJd(_company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const json = await atsFetchJson(jdUrl(posting.externalId), { provider: "magicpin", headers: authHeaders() });
    return magicpinJdFromDetail(json, { slug: posting.companySlug, jobId: posting.externalId });
  },
};
