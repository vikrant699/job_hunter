// src/ats/talentzq.ts — TalentzQ career boards (e.g. pratilipi.talentzq.io),
// a Blazor WebAssembly SPA fronting a per-tenant JSON API:
//
//   list:   GET https://<subdomain>.talentzq.io/api/<tenantId>/jd
//           -> the HTTP body is itself a JSON STRING containing the array's
//              JSON text (double-encoded) -> [ { Id, Title, Jdcode, Status,
//              Published, JobLocation: [[city, state, country], ...],
//              Jobtype, Experience, Skills, Datecreated, ... }, ... ]
//           One call returns the whole board (verified live: 23 records for
//           tenant 1009) — no pagination.
//   detail: GET https://<subdomain>.talentzq.io/api/<tenantId>/jd/<Jdcode>
//           -> singly-encoded JSON string containing the JD's HTML body.
//   public job page: https://<subdomain>.talentzq.io/JobView/<Jdcode>
//           (captured via the site's own click-through, since the listing
//           DOM uses JS click handlers rather than <a href>).
//
// The captured contract shows every request carrying a `?v=<token>` query
// param. Investigated live 2026-08-01 before writing this adapter:
//   - Omitting `v` entirely, and passing a deliberately wrong `v`, both
//     return identical 200 data from both the list and detail endpoints.
//   - A playwright capture of the real SPA shows the SAME `v` value reused
//     across totally unrelated endpoints (the company logo/banner image
//     requests) in the same page load.
// So `v` is a generic per-tenant cache-busting stamp, not a session/job
// token — the server never validates it. This adapter omits it.
//
// Only `Published === true` records are live postings — the rest are drafts/
// expired reqs the API still returns (verified: of 23 records for tenant
// 1009, exactly the 4 with Published:true matched what the public /careers
// page actually rendered).
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { atsFetchJson, parseOrNull } from "./http.js";
import { REMOTE_RE, dateToIso, joinLocation } from "./shared.js";
import { tryParseJson } from "../util/json.js";

export function talentzqListUrl(origin: string, tenantId: string): string {
  return `${origin}/api/${tenantId}/jd`;
}

export function talentzqDetailUrl(origin: string, tenantId: string, jdcode: string): string {
  return `${origin}/api/${tenantId}/jd/${encodeURIComponent(jdcode)}`;
}

export function talentzqJobViewUrl(origin: string, jdcode: string): string {
  return `${origin}/JobView/${encodeURIComponent(jdcode)}`;
}

export const TalentzqJobSchema = z.object({
  Id: z.string(),
  Title: z.string(),
  Jdcode: z.string(),
  Status: z.string().nullable().optional(),
  Jobcategory: z.string().nullable().optional(),
  Datecreated: z.string().nullable().optional(),
  Published: z.boolean().nullable().optional(),
  JobLocation: z.array(z.array(z.string())).nullable().optional(),
  Jobtype: z.string().nullable().optional(),
  Experience: z.string().nullable().optional(),
  Skills: z.array(z.string()).nullable().optional(),
});
export type TalentzqJob = z.infer<typeof TalentzqJobSchema>;

/** Unwrap the double-JSON-encoded list body (a JSON string whose parsed
 *  value is itself the array's JSON text). Never throws — anything that
 *  isn't a string, isn't valid JSON, or doesn't parse to an array yields []. */
export function talentzqJobsFrom(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  const parsed = tryParseJson(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** Only Published:true records are live postings — see module doc. */
export function talentzqShouldKeep(j: TalentzqJob): boolean {
  return j.Published === true;
}

function locationFrom(jobLocation: string[][] | null | undefined): string | null {
  const first = jobLocation?.[0];
  return first ? joinLocation(...first) : null;
}

export function normalizeTalentzq(company: AdapterCompany, origin: string, j: TalentzqJob): NormalizedPosting {
  const location = locationFrom(j.JobLocation);
  return {
    provider: "talentzq",
    externalId: j.Id,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.Title,
    jobUrl: talentzqJobViewUrl(origin, j.Jdcode),
    location,
    isRemote: location !== null && REMOTE_RE.test(location),
    // The list response carries no JD body; fetchJd fills this in.
    jdText: "",
    postedAt: dateToIso(j.Datecreated),
  };
}

/** Strip HTML from the (singly-encoded) detail response; "" on anything
 *  that isn't a string, so a malformed detail degrades instead of failing. */
export function talentzqJdText(raw: unknown): string {
  return htmlToText(typeof raw === "string" ? raw : "");
}

function originAndTenantId(company: AdapterCompany): { origin: string; tenantId: string } {
  const tenantId = company.apiMeta?.tenantId;
  if (!company.tenantUrl || !tenantId) {
    throw new Error(`talentzq adapter requires tenant_url + apiMeta.tenantId for ${company.slug}`);
  }
  return { origin: new URL(company.tenantUrl).origin, tenantId };
}

export const talentzqAdapter: AtsAdapter = {
  provider: "talentzq",

  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const { origin, tenantId } = originAndTenantId(company);
    const raw = await atsFetchJson(talentzqListUrl(origin, tenantId), { provider: "talentzq" });
    const out: NormalizedPosting[] = [];
    for (const r of talentzqJobsFrom(raw)) {
      const parsed = TalentzqJobSchema.safeParse(r);
      if (!parsed.success || !talentzqShouldKeep(parsed.data)) continue;
      out.push(normalizeTalentzq(company, origin, parsed.data));
    }
    return out;
  },

  async fetchJd(company: AdapterCompany, posting: NormalizedPosting): Promise<string> {
    const { origin, tenantId } = originAndTenantId(company);
    const parts = new URL(posting.jobUrl).pathname.split("/").filter(Boolean);
    const jdcode = parts[parts.length - 1];
    if (!jdcode) return "";
    const raw = await atsFetchJson(talentzqDetailUrl(origin, tenantId, jdcode), { provider: "talentzq" });
    const text = parseOrNull(z.string(), raw, { provider: "talentzq", slug: company.slug, what: "detail" });
    return talentzqJdText(text);
  },
};
