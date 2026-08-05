import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { Company } from "../types.js";
import type { Provider, ParsingStrategy, CompanyStatus } from "../schemas.js";
import { ProviderSchema, ParsingStrategySchema, CompanyStatusSchema } from "../schemas.js";
import { db, queryAll } from "./db.js";
import { parseApiMeta } from "./apiMeta.js";

/* ===== Row schema ===== */

const CompanyDbRowSchema = z.object({
  provider: ProviderSchema,
  slug: z.string(),
  name: z.string(),
  careers_url: z.string(),
  parsing_strategy: ParsingStrategySchema,
  status: CompanyStatusSchema,
  deny_reason: z.string().nullable(),
  discovered_via: z.string().nullable(),
  tenant_url: z.string().nullable(),
  api_meta: z.string().nullable(),
  discovered_at: z.string(),
  last_fetched_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_error: z.string().nullable(),
  consecutive_failures: z.number(),
  postings_seen_total: z.number(),
  postings_matched_total: z.number(),
  zero_yield_streak: z.number(),
  url_suspect: z.number(),
});

export type CompanyDbRow = z.infer<typeof CompanyDbRowSchema>;

/* ===== Helpers ===== */

export function rowToCompany(r: CompanyDbRow): Company {
  return {
    provider: r.provider,
    slug: r.slug,
    name: r.name,
    careersUrl: r.careers_url,
    parsingStrategy: r.parsing_strategy,
    status: r.status,
    denyReason: r.deny_reason,
    discoveredVia: r.discovered_via,
    tenantUrl: r.tenant_url,
    apiMeta: parseApiMeta(r.api_meta),
    discoveredAt: r.discovered_at,
    lastFetchedAt: r.last_fetched_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    postingsSeenTotal: r.postings_seen_total,
    postingsMatchedTotal: r.postings_matched_total,
    zeroYieldStreak: r.zero_yield_streak,
    urlSuspect: r.url_suspect !== 0,
  };
}

/* ===== Statements ===== */

const upsertCompanyStmt = db.prepare(`
  INSERT INTO companies (
    provider, slug, name, careers_url, parsing_strategy, status,
    deny_reason, discovered_via, tenant_url, api_meta, discovered_at
  ) VALUES (
    :provider, :slug, :name, :careersUrl, :parsingStrategy, :status,
    :denyReason, :discoveredVia, :tenantUrl, :apiMeta, :discoveredAt
  )
  ON CONFLICT(provider, slug) DO UPDATE SET
    name             = excluded.name,
    careers_url      = excluded.careers_url,
    parsing_strategy = excluded.parsing_strategy,
    status           = CASE
                         WHEN companies.status IN ('denied','broken','dormant') THEN companies.status
                         ELSE excluded.status
                       END,
    deny_reason      = excluded.deny_reason,
    tenant_url       = excluded.tenant_url,
    api_meta         = excluded.api_meta
`);
// Intentionally NOT updated on conflict:
//   discovered_via / discovered_at — provenance of the FIRST discovery, frozen.
//   broken status — a re-import alone doesn't prove the source recovered;
//   recovery from broken requires a human fixing the row on the Companies tab
//   (status cell back to active).
//   dormant status — set by applyDormancy from runtime yield data; a registry
//   re-sync must not wake a parked company (markFetchSuccess wakes it on jobs).

interface UpsertCompanyRow {
  [key: string]: SQLInputValue;
  provider: Provider;
  slug: string;
  name: string;
  careersUrl: string;
  parsingStrategy: ParsingStrategy;
  status: CompanyStatus;
  denyReason: string | null;
  discoveredVia: string | null;
  tenantUrl: string | null;
  apiMeta: string | null;
  discoveredAt: string;
}

export function upsertCompany(row: UpsertCompanyRow): void {
  upsertCompanyStmt.run(row);
}

const selectActiveCompaniesStmt = db.prepare(`
  SELECT * FROM companies
  WHERE status = 'active'
     OR (status = 'dormant' AND (last_fetched_at IS NULL OR last_fetched_at <= :dormantCutoff))
  ORDER BY provider, slug
`);

/** Dormant companies are rechecked weekly rather than every run. */
const DORMANT_RECHECK_DAYS = 7;

export function selectActiveCompanies(): Company[] {
  const dormantCutoff = new Date(Date.now() - DORMANT_RECHECK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return queryAll(selectActiveCompaniesStmt, CompanyDbRowSchema, { dormantCutoff }).map(rowToCompany);
}

const selectAllCompaniesStmt = db.prepare(`
  SELECT * FROM companies
`);

export function selectAllCompanies(): Company[] {
  return queryAll(selectAllCompaniesStmt, CompanyDbRowSchema).map(rowToCompany);
}

const deleteCompanyStmt = db.prepare(`
  DELETE FROM companies WHERE provider = :provider AND slug = :slug
`);

/** Remove a company row. Used by registry sync to prune rows no longer in the
 *  source-of-truth JSON (e.g. after a removal or a provider/slug conversion). */
export function deleteCompany(provider: Provider, slug: string): void {
  deleteCompanyStmt.run({ provider, slug });
}

const markFetchSuccessStmt = db.prepare(`
  UPDATE companies SET
    last_fetched_at      = :now,
    last_success_at      = :now,
    last_error           = NULL,
    consecutive_failures = 0,
    postings_seen_total  = postings_seen_total + :seen,
    zero_yield_streak    = CASE WHEN :seen > 0 THEN 0 ELSE zero_yield_streak + 1 END,
    url_suspect          = CASE WHEN :seen > 0 THEN 0 ELSE url_suspect END,
    status               = CASE
                             WHEN status = 'dormant' AND :seen > 0 THEN 'active'
                             ELSE status
                           END
  WHERE provider = :provider AND slug = :slug
`);

export function markFetchSuccess(
  provider: Provider,
  slug: string,
  postingsSeen: number,
): void {
  markFetchSuccessStmt.run({
    provider,
    slug,
    seen: postingsSeen,
    now: new Date().toISOString(),
  });
}

// In the CASE, `consecutive_failures` reads the PRE-update value (SQLite evaluates
// all SET expressions against the old row), so `+ 1 >= 5` flips to broken on the
// 5th consecutive failure — the same failure that writes the counter as 5.
const markFetchFailureStmt = db.prepare(`
  UPDATE companies SET
    last_fetched_at      = :now,
    last_error           = :err,
    consecutive_failures = consecutive_failures + 1,
    status               = CASE
                             WHEN consecutive_failures + 1 >= 5 THEN 'broken'
                             ELSE status
                           END
  WHERE provider = :provider AND slug = :slug
`);

export function markFetchFailure(
  provider: Provider,
  slug: string,
  err: string,
): void {
  markFetchFailureStmt.run({
    provider,
    slug,
    err: err.slice(0, 500),
    now: new Date().toISOString(),
  });
}

// Deliberately leaves consecutive_failures and status ALONE — see
// markTransportFailure. Only the diagnostic columns are written.
const markTransportFailureStmt = db.prepare(`
  UPDATE companies SET
    last_fetched_at = :now,
    last_error      = :err
  WHERE provider = :provider AND slug = :slug
`);

/**
 * Record a transport-layer failure (DNS/socket death — see isTransportError)
 * WITHOUT advancing the consecutive-failure counter that quarantines a board at
 * 5. The board never answered, so it told us nothing about its own health: a
 * dead resolver is not a dead board.
 *
 * Why this exists: in run 29 (2026-07-26) a ~9-minute local network outage made
 * 72 healthy Workday boards fail in 21 seconds. Counting those would have put
 * every one of them four runs from an automatic 'broken' flip, including Visa,
 * NVIDIA and Mastercard. The error text is still stored so the run is auditable.
 */
export function markTransportFailure(
  provider: Provider,
  slug: string,
  err: string,
): void {
  markTransportFailureStmt.run({
    provider,
    slug,
    err: err.slice(0, 500),
    now: new Date().toISOString(),
  });
}

const updateParsingStrategyStmt = db.prepare(`
  UPDATE companies SET parsing_strategy = :strategy
  WHERE provider = :provider AND slug = :slug
`);

/** Runtime strategy flip (SPA sentinel). Pair with updateRegistryStrategy —
 *  the registry file is the source of truth and re-syncs over this column. */
export function updateParsingStrategy(provider: Provider, slug: string, strategy: ParsingStrategy): void {
  updateParsingStrategyStmt.run({ provider, slug, strategy });
}

const markUrlSuspectStmt = db.prepare(`
  UPDATE companies SET url_suspect = 1 WHERE provider = :provider AND slug = :slug
`);

/** Page fetched OK but doesn't look like a careers page — flags it for manual repair. */
export function markUrlSuspect(provider: Provider, slug: string): void {
  markUrlSuspectStmt.run({ provider, slug });
}

const applyDormancyStmt = db.prepare(`
  UPDATE companies SET status = 'dormant'
  WHERE status = 'active'
    AND parsing_strategy IN ('llm-scrape','playwright-llm-scrape')
    AND zero_yield_streak >= :minStreak
`);

/**
 * Park scrape companies that have produced zero postings for `minStreak`
 * consecutive clean runs. They re-enter the rotation weekly
 * (selectActiveCompanies) and wake instantly when jobs appear
 * (markFetchSuccess). ats-api companies are exempt — an API call is too cheap
 * to be worth parking. Returns the number of companies parked.
 *
 * url_suspect boards used to be exempt on the theory that a suspect URL needs
 * manual repair rather than parking. In practice that exempted 96 boards from
 * ever being parked, so each run paid a headless-browser render for pages that
 * had returned nothing for up to 18 runs. Parking them still leaves them in the
 * weekly recheck, so a repaired URL recovers on its own.
 */
export function applyDormancy(minStreak: number = 3): number {
  const result = applyDormancyStmt.run({ minStreak });
  return Number(result.changes);
}

const bumpMatchedStmt = db.prepare(`
  UPDATE companies SET postings_matched_total = postings_matched_total + 1
  WHERE provider = :provider AND slug = :slug
`);

export function bumpMatched(provider: Provider, slug: string): void {
  bumpMatchedStmt.run({ provider, slug });
}
