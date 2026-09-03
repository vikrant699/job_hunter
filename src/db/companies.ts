import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { Company } from "../types.js";
import type { Provider, ParsingStrategy, CompanyStatus } from "../schemas.js";
import { ProviderSchema, ParsingStrategySchema, CompanyStatusSchema } from "../schemas.js";
import { db, queryAll } from "./db.js";
import { parseApiMeta } from "./apiMeta.js";

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
// Not updated on conflict: discovered_via/discovered_at (frozen at first discovery); broken/dormant status (a re-import alone doesn't prove recovery).

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

/** Removes a company row; used by registry sync to prune rows no longer in the source-of-truth JSON. */
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

// `consecutive_failures` in the CASE reads the pre-update value, so `+ 1 >= 5` flips to broken on the same failure that writes the counter as 5.
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

// Deliberately leaves consecutive_failures and status ALONE; only the diagnostic columns are written.
const markTransportFailureStmt = db.prepare(`
  UPDATE companies SET
    last_fetched_at = :now,
    last_error      = :err
  WHERE provider = :provider AND slug = :slug
`);

/** Records a transport-layer failure (DNS/socket death) without advancing the consecutive-failure counter that quarantines a board at 5 - a board that never answered told us nothing about its own health. */
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

/** Runtime strategy flip; pair with updateRegistryStrategy, since the registry file re-syncs over this column. */
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

/** Parks scrape companies (ats-api is exempt - too cheap to bother) with zero postings for `minStreak` consecutive clean runs; they re-enter the weekly recheck and wake instantly on jobs. */
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
