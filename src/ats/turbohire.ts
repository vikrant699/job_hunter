// src/ats/turbohire.ts — TurboHire career boards (Flipkart group, Ola,
// Tata Motors PV, Britannia).
//
// Anon-token handshake, both hosted on thapi.azurewebsites.net (WAF-blocks
// plain Node fetch — browser-backed like Darwinbox):
//   1. GET  /api/token/noauth                         -> { access_token, ... }
//   2. POST /api/careerpagev2/filteredjobs?orgId=<id> -> { Total, Result: Job[] }
//      body { pageNumber, pageSize, searchText: "" }, header
//      Authorization: Bearer <access_token>.
// Confirmed live against Flipkart's tenant: the endpoint ignores
// pageNumber/pageSize and returns every matching job (up to `Total`) on the
// very first call, but we still paginate defensively (see mergeTurboHirePages)
// in case a larger tenant's endpoint behaves differently.
//
// The full JD is inline (`JobDescV2`, HTML) — no per-job fetchJd needed.
import { z } from "zod";
import { logger } from "../logger.js";
import type { AtsAdapter } from "./types.js";
import type { AdapterCompany, NormalizedPosting } from "../types.js";
import { htmlToText } from "./html-text.js";
import { browserFetchJsonSteps } from "./browser-fetch.js";
import { REMOTE_RE } from "./shared.js";

export const TURBOHIRE_TOKEN_URL = "https://thapi.azurewebsites.net/api/token/noauth";
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

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

/** `https://<accountName>.turbohire.co` from the careers/tenant URL. */
export function turboHireAccountOrigin(company: AdapterCompany): string {
  const u = new URL(company.tenantUrl ?? company.careersUrl);
  return `${u.protocol}//${u.host}`;
}

/** The public careerpage URL for a given org — also what the browser navigates to. */
export function turboHireCareerPageUrl(company: AdapterCompany, orgId: string): string {
  return `${turboHireAccountOrigin(company)}/careerpage/${orgId}`;
}

/** The token-gated jobs-search endpoint (shared thapi host, orgId in the query string). */
export function turboHireFilteredJobsUrl(orgId: string): string {
  return `https://thapi.azurewebsites.net/api/careerpagev2/filteredjobs?orgId=${encodeURIComponent(orgId)}`;
}

function requireOrgId(company: AdapterCompany): string {
  const orgId = company.apiMeta?.orgId;
  if (!orgId) throw new Error(`turbohire adapter requires apiMeta.orgId for ${company.slug}`);
  return orgId;
}

/**
 * `Location` arrives as a JSON-ENCODED STRING (not a parsed object) of
 * `[{Address, PlaceId}]`. Extract and join every non-empty Address; null on
 * missing/malformed input rather than throwing — a location parse failure
 * shouldn't sink the whole posting.
 */
const TurboHireLocationEntrySchema = z.object({ Address: z.string().nullable().optional() });
const TurboHireLocationArraySchema = z.array(TurboHireLocationEntrySchema);

export function parseTurboHireLocation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = TurboHireLocationArraySchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  const addresses = parsed.data
    .map((entry) => entry.Address)
    .filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  return addresses.length > 0 ? addresses.join("; ") : null;
}

/**
 * TurboHire's PublishedDate carries a trailing "Z"; UpdatedDate doesn't, even
 * though it's the same backend-UTC timestamp format — parsing it bare would
 * have `Date.parse` interpret it in the machine's LOCAL timezone (silently
 * wrong, and non-deterministic across environments). Append "Z" whenever no
 * zone designator is already present.
 */
function parseTurboHireDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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

/**
 * Accumulate already-fetched filteredjobs list pages (page 2+) into `out`,
 * mutating it in place. Stops early on an empty page or once `total` is
 * reached. Throws — rather than warning and truncating — on a schema
 * mismatch, since a silent `break` here would return a partial list that
 * looks complete (page 1 already throws loudly on the same mismatch, so a
 * mid-stream one must too).
 */
export function mergeTurboHirePages(
  company: AdapterCompany,
  out: NormalizedPosting[],
  pages: unknown[],
  total: number,
): void {
  for (const raw of pages) {
    const parsed = TurboHireListSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `turbohire: page schema mismatch mid-pagination for ${company.slug} ` +
        `(fetched ${out.length}/${total} so far): ${JSON.stringify(parsed.error.issues.slice(0, 2))}`,
      );
    }
    if (parsed.data.Result.length === 0) break;
    for (const j of parsed.data.Result) out.push(normalizeTurboHire(company, j));
    if (out.length >= total) break;
  }
}

export const turbohireAdapter: AtsAdapter = {
  provider: "turbohire",
  async listPostings(company: AdapterCompany): Promise<NormalizedPosting[]> {
    const orgId = requireOrgId(company);
    const careersUrl = turboHireCareerPageUrl(company, orgId);
    const out: NormalizedPosting[] = [];

    // One browser session: get the anon token, then page 1. Page 1 reveals
    // `Total` for the deciding-whether-to-paginate-further check below.
    // blockHeavyAssets:false — confirmed live on the Ola tenant: this app
    // treats ANY aborted request (even an unrelated stylesheet) as fatal and
    // reloads the main frame in a loop, which can tear down our evaluate
    // mid-flight. It's a one-shot handshake, not a scrape, so leave assets on.
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

    const tokenParsed = TurboHireTokenSchema.safeParse(first[0]);
    if (!tokenParsed.success) {
      logger.warn({ slug: company.slug, issues: tokenParsed.error.issues.slice(0, 2) }, "turbohire token schema mismatch");
      throw new Error(`turbohire token fetch failed for ${company.slug}`);
    }
    const parsed0 = TurboHireListSchema.safeParse(first[1]);
    if (!parsed0.success) {
      logger.warn({ slug: company.slug, issues: parsed0.error.issues.slice(0, 2) }, "turbohire list schema mismatch");
      throw new Error(`turbohire list failed schema for ${company.slug}`);
    }
    for (const j of parsed0.data.Result) out.push(normalizeTurboHire(company, j));
    const total = parsed0.data.Total ?? out.length;

    // If more pages are needed, fetch them ALL in one more browser session
    // (one navigation → re-derive the token → N in-page XHR fetches), instead
    // of one navigation per page.
    if (out.length < total) {
      const pageSize = parsed0.data.Result.length || 1;
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
