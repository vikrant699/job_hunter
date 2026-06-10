import { type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { Company } from "../types.js";
import type { Provider, ParsingStrategy, CompanyStatus } from "../schemas.js";
import { ProviderSchema, ParsingStrategySchema, CompanyStatusSchema } from "../schemas.js";
import { db, queryAll } from "./db.js";
import { parseApiMeta } from "./api-meta.js";

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
                         WHEN companies.status IN ('denied','broken') THEN companies.status
                         ELSE excluded.status
                       END,
    deny_reason      = excluded.deny_reason,
    tenant_url       = excluded.tenant_url,
    api_meta         = excluded.api_meta
`);
// Intentionally NOT updated on conflict:
//   discovered_via / discovered_at — provenance of the FIRST discovery, frozen.
//   broken status — a re-import alone doesn't prove the source recovered; repair
//   goes through url-repair, which resets broken -> candidate alongside a fixed URL.

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
  WHERE status IN ('active','candidate','dormant')
  ORDER BY provider, slug
`);

export function selectActiveCompanies(): Company[] {
  return queryAll(selectActiveCompaniesStmt, CompanyDbRowSchema).map(rowToCompany);
}

const selectAllCompaniesStmt = db.prepare(`
  SELECT * FROM companies
`);

export function selectAllCompanies(): Company[] {
  return queryAll(selectAllCompaniesStmt, CompanyDbRowSchema).map(rowToCompany);
}

const markFetchSuccessStmt = db.prepare(`
  UPDATE companies SET
    last_fetched_at      = :now,
    last_success_at      = :now,
    last_error           = NULL,
    consecutive_failures = 0,
    postings_seen_total  = postings_seen_total + :seen,
    status               = CASE
                             WHEN status = 'candidate' AND :seen > 0 THEN 'active'
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

const bumpMatchedStmt = db.prepare(`
  UPDATE companies SET postings_matched_total = postings_matched_total + 1
  WHERE provider = :provider AND slug = :slug
`);

export function bumpMatched(provider: Provider, slug: string): void {
  bumpMatchedStmt.run({ provider, slug });
}
