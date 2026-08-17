// src/ats/turbohire.ts — TurboHire career boards (Flipkart group, Ola, Tata Motors PV,
// Britannia). Anon-token handshake, both hosted on thapi.azurewebsites.net (WAF-blocks
// plain Node fetch — browser-backed like Darwinbox):
//   1. GET  /api/token/noauth                         -> { access_token, ... }
//   2. POST /api/careerpagev2/filteredjobs?orgId=<id> -> { Total, Result: Job[] }
// The endpoint ignores pageNumber/pageSize and returns every matching job on the first
// call (confirmed live against Flipkart), but we still paginate defensively in case a
// larger tenant behaves differently. Full JD is inline (JobDescV2, HTML) — no fetchJd needed.
import { z } from "zod";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./htmlText.js";
import { browserFetchJsonSteps } from "./browserFetch.js";
import { parseOrThrow } from "./http.js";
import { REMOTE_RE, dateToIso, tenantOrigin } from "./shared.js";
import { tryParseJson } from "../util/json.js";
import type { JsonValue } from "../util/json.js";

export const TURBOHIRE_TOKEN_URL = "https://thapi.azurewebsites.net/api/token/noauth";
const PAGE_SIZE = 50;
const MAX_PAGES = 5000; // runaway backstop only — fetch every page (never truncate)

const TurboHireTokenSchema = z.object({ access_token: z.string() });

const TurboHireJobSchema = z.object({
  JobId: z.string(),
  JobTitle: z.string(),
  Department: z.string().nullable().optional(),
  Location: z.string().nullable().optional(),
  JobDescV2: z.string().nullable().optional(),
  PublishedDate: z.string().nullable().optional(),
  UpdatedDate: z.string().nullable().optional(),
  Type: z.string().nullable().optional(),
});
export type TurboHireJob = z.infer<typeof TurboHireJobSchema>;

const TurboHireListSchema = z.object({
  Total: z.number().nullable().optional(),
  Result: z.array(TurboHireJobSchema),
});

// `https://<accountName>.turbohire.co` from the careers/tenant URL.
export function turboHireAccountOrigin(company: AdapterCompany): string {
  return tenantOrigin(company);
}

// The public careerpage URL for a given org — also what the browser navigates to.
export function turboHireCareerPageUrl(company: AdapterCompany, orgId: string): string {
  return `${turboHireAccountOrigin(company)}/careerpage/${orgId}`;
}

// The token-gated jobs-search endpoint (shared thapi host, orgId in the query string).
export function turboHireFilteredJobsUrl(orgId: string): string {
  return `https://thapi.azurewebsites.net/api/careerpagev2/filteredjobs?orgId=${encodeURIComponent(orgId)}`;
}

function requireOrgId(company: AdapterCompany): string {
  const orgId = company.apiMeta?.orgId;
  if (!orgId) throw new Error(`turbohire adapter requires apiMeta.orgId for ${company.slug}`);
  return orgId;
}

// `Location` arrives as a JSON-ENCODED STRING of `[{Address, PlaceId}]`; extract and join
// every non-empty Address. Null on missing/malformed input rather than throwing.
const TurboHireLocationEntrySchema = z.object({ Address: z.string().nullable().optional() });
const TurboHireLocationArraySchema = z.array(TurboHireLocationEntrySchema);

export function parseTurboHireLocation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsedJson = tryParseJson(raw);
  if (parsedJson === null) return null;
  const parsed = TurboHireLocationArraySchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  const addresses = parsed.data
    .map((entry) => entry.Address)
    .filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  return addresses.length > 0 ? addresses.join("; ") : null;
}

// PublishedDate carries a trailing "Z"; UpdatedDate doesn't despite being the same
// backend-UTC format — append "Z" when no zone designator is present, else Date.parse
// would read it in the machine's local timezone.
function parseTurboHireDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  return dateToIso(withZone);
}

export function turboHireJobUrl(company: AdapterCompany, jobId: string): string {
  return `${turboHireAccountOrigin(company)}/job/publicjobs/${jobId}`;
}

export function normalizeTurboHire(company: AdapterCompany, j: TurboHireJob): NormalizedPosting {
  const location = parseTurboHireLocation(j.Location);
  return {
    provider: "turbohire",
    externalId: j.JobId,
    companySlug: company.slug,
    companyName: company.name,
    jobTitle: j.JobTitle,
    jobUrl: turboHireJobUrl(company, j.JobId),
    location,
    isRemote: REMOTE_RE.test(`${j.Type ?? ""} ${location ?? ""}`),
    jdText: htmlToText(j.JobDescV2 ?? ""),
    postedAt: parseTurboHireDate(j.PublishedDate) ?? parseTurboHireDate(j.UpdatedDate),
  };
}

// Accumulates already-fetched filteredjobs pages (page 2+) into `out`. Stops early on an
// empty page or once `total` is reached; throws (not warn+truncate) on schema mismatch,
// since page 1 already throws on the same mismatch and a mid-stream break would look complete.
// Dedupes by JobId since this endpoint ignores pageNumber/pageSize and could re-serve page 1.
export function mergeTurboHirePages(
  company: AdapterCompany,
  out: NormalizedPosting[],
  pages: JsonValue[],
  total: number,
): void {
  const seen = new Set(out.map((p) => p.externalId));
  for (const raw of pages) {
    const parsed = parseOrThrow(TurboHireListSchema, raw, {
      provider: "turbohire",
      slug: company.slug,
      what: `page (fetched ${out.length}/${total} so far)`,
    });
    if (parsed.Result.length === 0) break;
    for (const j of parsed.Result) {
      if (seen.has(j.JobId)) continue;
      seen.add(j.JobId);
      out.push(normalizeTurboHire(company, j));
    }
    if (out.length >= total) break;
  }
}

export const turbohireAdapter: AtsAdapter = {
  provider: "turbohire",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const orgId = requireOrgId(company);
    const careersUrl = turboHireCareerPageUrl(company, orgId);
    const out: NormalizedPosting[] = [];

    // One browser session: get the anon token, then page 1 (reveals Total).
    // blockHeavyAssets:false — confirmed live on Ola: this app treats ANY aborted request
    // (even an unrelated stylesheet) as fatal and reloads the main frame, tearing down our
    // evaluate mid-flight. It's a one-shot handshake, not a scrape, so leave assets on.
    const first = await browserFetchJsonSteps(careersUrl, (soFar) => {
      if (soFar.length === 0) return { url: TURBOHIRE_TOKEN_URL };
      if (soFar.length === 1) {
        const token = TurboHireTokenSchema.safeParse(soFar[0]);
        if (!token.success) return null; // surfaced as a schema-mismatch error below
        return {
          url: turboHireFilteredJobsUrl(orgId),
          method: "POST",
          headers: { Authorization: `Bearer ${token.data.access_token}` },
          body: { pageNumber: 1, pageSize: PAGE_SIZE, searchText: "" },
        };
      }
      return null;
    }, { blockHeavyAssets: false });

    // Validation-only: the token was already consumed inside the callback above.
    parseOrThrow(TurboHireTokenSchema, first[0] ?? null, { provider: "turbohire", slug: company.slug, what: "token" });
    const parsed0 = parseOrThrow(TurboHireListSchema, first[1] ?? null, { provider: "turbohire", slug: company.slug });
    for (const j of parsed0.Result) out.push(normalizeTurboHire(company, j));
    const total = parsed0.Total ?? out.length;

    // If more pages are needed, fetch them ALL in one more browser session instead of one navigation per page.
    if (out.length < total) {
      const pageSize = parsed0.Result.length || 1;
      const pagesNeeded = Math.min(Math.ceil(total / pageSize), MAX_PAGES);
      if (pagesNeeded >= 2) {
        const rest = await browserFetchJsonSteps(careersUrl, (soFar) => {
          if (soFar.length === 0) return { url: TURBOHIRE_TOKEN_URL };
          const restToken = TurboHireTokenSchema.safeParse(soFar[0]);
          if (!restToken.success) return null;
          const listPagesFetched = soFar.length - 1;
          if (listPagesFetched >= pagesNeeded - 1) return null;
          return {
            url: turboHireFilteredJobsUrl(orgId),
            method: "POST",
            headers: { Authorization: `Bearer ${restToken.data.access_token}` },
            body: { pageNumber: listPagesFetched + 2, pageSize, searchText: "" },
          };
        }, { blockHeavyAssets: false });
        mergeTurboHirePages(company, out, rest.slice(1), total);
      }
    }
    return out;
  },
};
