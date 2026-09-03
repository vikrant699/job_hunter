// src/ats/talentzq.ts — TalentzQ career boards (e.g. pratilipi.talentzq.io), a Blazor WebAssembly SPA fronting a per-tenant JSON API.
// List: GET <subdomain>.talentzq.io/api/<tenantId>/jd, whole board in one call (no pagination), body a double-JSON-encoded string. Detail: GET .../api/<tenantId>/jd/<Jdcode>, singly-encoded JSON string of the JD HTML; the public job page is .../JobView/<Jdcode>.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { atsFetchJson, parseOrNull } from "./http.js";
import { REMOTE_RE, dateToIso, joinLocation } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

// Every request carries a `?v=<token>` query param on the live site; verified that omitting it (or passing garbage) returns identical 200 data and the same value recurs across unrelated image requests too — it's a cache-busting stamp, not a session token, so these URLs omit it.
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

// Unwraps the double-JSON-encoded list body. Never throws — anything that isn't a valid JSON string parsing to an array yields [].
export function talentzqJobsFrom(raw: JsonValue): JsonValue[] {
  if (typeof raw !== "string") return [];
  const parsed = tryParseJson(raw);
  return Array.isArray(parsed) ? parsed : [];
}

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
    jdText: "",
    postedAt: dateToIso(j.Datecreated),
  };
}

// Strips HTML from the (singly-encoded) detail response; "" on anything not a string.
export function talentzqJdText(raw: JsonValue): string {
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
