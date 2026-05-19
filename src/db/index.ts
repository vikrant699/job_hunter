import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Company, NormalizedPosting, Provider, ParsingStrategy, CompanyStatus } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "schema.sql");
const dbPath = resolve(process.cwd(), config.storage.dbPath);

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const schema = readFileSync(schemaPath, "utf-8");
db.exec(schema);

logger.info({ path: dbPath }, "sqlite initialized");

/* ===== companies ===== */

const upsertCompanyStmt = db.prepare(`
  INSERT INTO companies (
    provider, slug, name, careers_url, parsing_strategy, status,
    deny_reason, discovered_via, tenant_url, discovered_at
  ) VALUES (
    :provider, :slug, :name, :careersUrl, :parsingStrategy, :status,
    :denyReason, :discoveredVia, :tenantUrl, :discoveredAt
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
    tenant_url       = excluded.tenant_url
`);

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

interface CompanyDbRow {
  provider: Provider;
  slug: string;
  name: string;
  careers_url: string;
  parsing_strategy: ParsingStrategy;
  status: CompanyStatus;
  deny_reason: string | null;
  discovered_via: string | null;
  tenant_url: string | null;
  discovered_at: string;
  last_fetched_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  postings_seen_total: number;
  postings_matched_total: number;
}

function rowToCompany(r: CompanyDbRow): Company {
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
    discoveredAt: r.discovered_at,
    lastFetchedAt: r.last_fetched_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    consecutiveFailures: r.consecutive_failures,
    postingsSeenTotal: r.postings_seen_total,
    postingsMatchedTotal: r.postings_matched_total,
  };
}

export function selectActiveCompanies(): Company[] {
  return (selectActiveCompaniesStmt.all() as unknown as CompanyDbRow[]).map(rowToCompany);
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

export function markFetchSuccess(provider: Provider, slug: string, postingsSeen: number): void {
  markFetchSuccessStmt.run({
    provider,
    slug,
    seen: postingsSeen,
    now: new Date().toISOString(),
  });
}

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

export function markFetchFailure(provider: Provider, slug: string, err: string): void {
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

/* ===== postings ===== */

const insertPostingStmt = db.prepare(`
  INSERT INTO postings (
    provider, external_id, company_slug, job_title, job_url, location,
    is_remote, jd_text, posted_at, discovered_at
  ) VALUES (
    :provider, :externalId, :companySlug, :jobTitle, :jobUrl, :location,
    :isRemote, :jdText, :postedAt, :discoveredAt
  )
  ON CONFLICT(provider, external_id) DO NOTHING
`);

/** Returns true if the row was inserted (i.e. a new posting). */
export function insertPostingIfNew(p: NormalizedPosting): boolean {
  const result = insertPostingStmt.run({
    provider: p.provider,
    externalId: p.externalId,
    companySlug: p.companySlug,
    jobTitle: p.jobTitle,
    jobUrl: p.jobUrl,
    location: p.location,
    isRemote: p.isRemote ? 1 : 0,
    jdText: p.jdText,
    postedAt: p.postedAt,
    discoveredAt: new Date().toISOString(),
  });
  return (result.changes ?? 0) > 0;
}

const postingExistsStmt = db.prepare(`
  SELECT 1 FROM postings WHERE provider = :provider AND external_id = :externalId LIMIT 1
`);

export function postingExists(provider: Provider, externalId: string): boolean {
  return postingExistsStmt.get({ provider, externalId }) !== undefined;
}

const updatePostingResultStmt = db.prepare(`
  UPDATE postings SET
    llm_relevant   = :llmRelevant,
    llm_reason     = :llmReason,
    llm_confidence = :llmConfidence,
    yoe_min        = :yoeMin,
    yoe_max        = :yoeMax,
    drop_stage     = :dropStage,
    notified_at    = :notifiedAt
  WHERE provider = :provider AND external_id = :externalId
`);

export interface PostingResultUpdate {
  [key: string]: SQLInputValue;
  provider: Provider;
  externalId: string;
  llmRelevant: number | null;
  llmReason: string | null;
  llmConfidence: number | null;
  yoeMin: number | null;
  yoeMax: number | null;
  dropStage: string | null;
  notifiedAt: string | null;
}

export function updatePostingResult(update: PostingResultUpdate): void {
  updatePostingResultStmt.run(update);
}

/* ===== brave quota tracking ===== */

const selectBraveQuotaStmt = db.prepare(
  "SELECT count FROM brave_quota WHERE month = :month"
);
const upsertBraveQuotaStmt = db.prepare(`
  INSERT INTO brave_quota (month, count, updated_at) VALUES (:month, :count, :now)
  ON CONFLICT(month) DO UPDATE SET count = :count, updated_at = :now
`);

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function getBraveQuotaUsed(): number {
  const row = selectBraveQuotaStmt.get({ month: currentMonthKey() }) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function incrementBraveQuota(by: number = 1): number {
  const month = currentMonthKey();
  const next = getBraveQuotaUsed() + by;
  upsertBraveQuotaStmt.run({ month, count: next, now: new Date().toISOString() });
  return next;
}

/* ===== link cache (for llm-scrape shortlist) ===== */

export interface ShortlistedLink {
  url: string;
  title: string;
}

const selectLinkCacheStmt = db.prepare(`
  SELECT links_json, cached_at FROM link_cache
  WHERE provider = :provider AND slug = :slug
`);

const upsertLinkCacheStmt = db.prepare(`
  INSERT INTO link_cache (provider, slug, links_json, cached_at)
  VALUES (:provider, :slug, :linksJson, :cachedAt)
  ON CONFLICT(provider, slug) DO UPDATE SET
    links_json = excluded.links_json,
    cached_at  = excluded.cached_at
`);

interface LinkCacheRow { links_json: string; cached_at: string }

export function getLinkCache(
  provider: Provider,
  slug: string,
  ttlMs: number
): ShortlistedLink[] | null {
  const row = selectLinkCacheStmt.get({ provider, slug }) as LinkCacheRow | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.cached_at).getTime();
  if (!Number.isFinite(age) || age > ttlMs) return null;
  try {
    const parsed = JSON.parse(row.links_json);
    return Array.isArray(parsed) ? (parsed as ShortlistedLink[]) : null;
  } catch {
    return null;
  }
}

export function setLinkCache(provider: Provider, slug: string, links: ShortlistedLink[]): void {
  upsertLinkCacheStmt.run({
    provider,
    slug,
    linksJson: JSON.stringify(links),
    cachedAt: new Date().toISOString(),
  });
}

/* ===== daily CSV queries ===== */

const selectAllCompaniesStmt = db.prepare(`
  SELECT * FROM companies
`);

export function selectAllCompanies(): Company[] {
  return (selectAllCompaniesStmt.all() as unknown as CompanyDbRow[]).map(rowToCompany);
}

interface PostingTallyRow {
  company_slug: string;
  provider: Provider;
  total_new: number;
  green: number;
  yellow: number;
}

const tallyPostingsSinceStmt = db.prepare(`
  SELECT provider, company_slug,
         COUNT(*) AS total_new,
         SUM(CASE WHEN notified_at IS NOT NULL AND drop_stage IS NULL THEN 1 ELSE 0 END) AS green,
         SUM(CASE WHEN notified_at IS NOT NULL AND drop_stage = 'yellow' THEN 1 ELSE 0 END) AS yellow
  FROM postings
  WHERE discovered_at >= :since
  GROUP BY provider, company_slug
`);

export function tallyPostingsSince(sinceIso: string): Map<string, { totalNew: number; green: number; yellow: number }> {
  const rows = tallyPostingsSinceStmt.all({ since: sinceIso }) as unknown as PostingTallyRow[];
  const out = new Map<string, { totalNew: number; green: number; yellow: number }>();
  for (const r of rows) {
    out.set(`${r.provider}::${r.company_slug}`, { totalNew: r.total_new, green: Number(r.green ?? 0), yellow: Number(r.yellow ?? 0) });
  }
  return out;
}

/* ===== runs ===== */

const insertRunStmt = db.prepare(`
  INSERT INTO runs (kind, started_at) VALUES (:kind, :startedAt)
`);

export function startRun(kind: "production" | "discovery"): number {
  const result = insertRunStmt.run({ kind, startedAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

const finishRunStmt = db.prepare(`
  UPDATE runs SET
    ended_at          = :endedAt,
    companies_scanned = :companiesScanned,
    postings_seen     = :postingsSeen,
    postings_new      = :postingsNew,
    postings_notified = :postingsNotified,
    candidates_added  = :candidatesAdded,
    error             = :error
  WHERE id = :id
`);

export interface FinishRunInput {
  [key: string]: SQLInputValue;
  id: number;
  endedAt: string;
  companiesScanned: number;
  postingsSeen: number;
  postingsNew: number;
  postingsNotified: number;
  candidatesAdded: number | null;
  error: string | null;
}

export function finishRun(input: FinishRunInput): void {
  finishRunStmt.run(input);
}
