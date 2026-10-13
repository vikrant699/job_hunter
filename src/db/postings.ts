import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { NormalizedPosting } from "../types.js";
import type { Provider, Severity } from "../schemas.js";
import { ProviderSchema } from "../schemas.js";
import { db, queryAll, queryOne } from "./db.js";

// jdText is deliberately not persisted: the gate consumes it in-memory.
const insertPostingStmt = db.prepare(`
  INSERT INTO postings (
    provider, external_id, profile_id, company_slug, job_title, job_url, location,
    is_remote, posted_at, discovered_at, last_seen_at
  ) VALUES (
    :provider, :externalId, :profileId, :companySlug, :jobTitle, :jobUrl, :location,
    :isRemote, :postedAt, :discoveredAt, :lastSeenAt
  )
  ON CONFLICT(provider, external_id, profile_id) DO NOTHING
`);

export function insertPostingIfNew(p: NormalizedPosting, profileId: string): boolean {
  const discoveredAt = new Date().toISOString();
  const result = insertPostingStmt.run({
    provider: p.provider,
    externalId: p.externalId,
    profileId,
    companySlug: p.companySlug,
    jobTitle: p.jobTitle,
    jobUrl: p.jobUrl,
    location: p.location,
    isRemote: p.isRemote ? 1 : 0,
    postedAt: p.postedAt,
    discoveredAt,
    lastSeenAt: discoveredAt,
  });
  return result.changes > 0;
}

// node:sqlite has no array bind for IN(...); placeholders are built per call, chunked under ~999 params.
const SEEN_CHUNK_SIZE = 500;

/** Callers pass the FULL listing: "seen" doesn't depend on relevance. */
export function markSeen(
  provider: Provider,
  companySlug: string,
  profileId: string,
  externalIds: string[],
  seenAt: string,
): void {
  for (let i = 0; i < externalIds.length; i += SEEN_CHUNK_SIZE) {
    const chunk = externalIds.slice(i, i + SEEN_CHUNK_SIZE);
    const placeholders = chunk.map((_, idx) => `:id${idx}`).join(", ");
    const stmt = db.prepare(`
      UPDATE postings SET last_seen_at = :seenAt, removed_at = NULL
      WHERE provider = :provider AND company_slug = :companySlug AND profile_id = :profileId
        AND external_id IN (${placeholders})
    `);
    const params: Record<string, SQLInputValue> = { seenAt, provider, companySlug, profileId };
    chunk.forEach((id, idx) => {
      params[`id${idx}`] = id;
    });
    stmt.run(params);
  }
}

const markRemovedStmt = db.prepare(`
  UPDATE postings SET removed_at = :removedAt
  WHERE provider = :provider AND company_slug = :companySlug AND profile_id = :profileId
    AND removed_at IS NULL AND last_seen_at < :fetchStartedAt
`);

/** The fetchStartedAt bound protects a parallel company's fresh rows; never widen this WHERE. */
export function markRemoved(
  provider: Provider,
  companySlug: string,
  profileId: string,
  fetchStartedAt: string,
  removedAt: string,
): number {
  const result = markRemovedStmt.run({ provider, companySlug, profileId, fetchStartedAt, removedAt });
  return Number(result.changes);
}

const CountSchema = z.object({ n: z.number() });

const countInsertedSinceStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM postings
  WHERE provider = :provider AND company_slug = :companySlug AND profile_id = :profileId
    AND discovered_at >= :sinceIso
`);

export function countInsertedSince(provider: Provider, companySlug: string, profileId: string, sinceIso: string): number {
  const row = queryOne(countInsertedSinceStmt, CountSchema, { provider, companySlug, profileId, sinceIso });
  return row?.n ?? 0;
}

const countRemovedNotifiedSinceStmt = db.prepare(`
  SELECT COUNT(*) AS n
  FROM postings p
  WHERE p.notified_at IS NOT NULL
    AND p.notified_at >= :sinceIso
    AND p.profile_id = :profileId
    AND p.removed_at IS NOT NULL
`);

export function countRemovedNotifiedSince(sinceIso: string, profileId: string): number {
  const row = queryOne(countRemovedNotifiedSinceStmt, CountSchema, { sinceIso, profileId });
  return row?.n ?? 0;
}

const postingExistsStmt = db.prepare(`
  SELECT 1 FROM postings WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId LIMIT 1
`);

export function postingExists(provider: Provider, externalId: string, profileId: string): boolean {
  return postingExistsStmt.get({ provider, externalId, profileId }) !== undefined;
}

const PostingJdStateRowSchema = z.object({ drop_stage: z.string().nullable(), jd_checked_at: z.string() });

const getPostingJdStateStmt = db.prepare(`
  SELECT drop_stage, COALESCE(jd_checked_at, discovered_at) AS jd_checked_at
  FROM postings WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId
`);

export interface PostingJdState {
  dropStage: string | null;
  jdCheckedAt: string;
}

export function getPostingJdState(provider: Provider, externalId: string, profileId: string): PostingJdState | undefined {
  const row = queryOne(getPostingJdStateStmt, PostingJdStateRowSchema, { provider, externalId, profileId });
  if (!row) return undefined;
  return { dropStage: row.drop_stage, jdCheckedAt: row.jd_checked_at };
}

// The due-check is in the WHERE so two racing workers can't both claim it.
const claimRecheckStmt = db.prepare(`
  UPDATE postings SET
    jd_checked_at = :checkedAt,
    job_title     = :jobTitle,
    job_url       = :jobUrl,
    location      = :location,
    is_remote     = :isRemote,
    posted_at     = :postedAt
  WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId
    AND drop_stage = :dropStage AND COALESCE(jd_checked_at, discovered_at) < :dueBefore
`);

export type RecheckStage = "no-jd" | "gate-error";

export function claimRecheck(p: NormalizedPosting, profileId: string, dropStage: RecheckStage, dueBefore: string, checkedAt: string): boolean {
  const result = claimRecheckStmt.run({
    dropStage,
    provider: p.provider,
    externalId: p.externalId,
    profileId,
    checkedAt,
    dueBefore,
    jobTitle: p.jobTitle,
    jobUrl: p.jobUrl,
    location: p.location,
    isRemote: p.isRemote ? 1 : 0,
    postedAt: p.postedAt,
  });
  return result.changes > 0;
}

const NotifiedRoleKeySchema = z.object({
  company: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
});

const selectNotifiedRoleKeysStmt = db.prepare(`
  SELECT c.name AS company, p.job_title AS title, p.location AS location
  FROM postings p
  LEFT JOIN companies c ON c.provider = p.provider AND c.slug = p.company_slug
  WHERE p.notified_at IS NOT NULL AND p.notified_at >= :cutoff AND p.profile_id = :profileId
`);

// A role re-posted after this long is worth a fresh ping.
const NOTIFY_DEDUP_WINDOW_DAYS = 180;

/** Reposts get a fresh external_id and would otherwise slip past postingExists. */
export function selectNotifiedRoleKeys(profileId: string): Array<{
  company: string | null;
  title: string | null;
  location: string | null;
}> {
  const cutoff = new Date(Date.now() - NOTIFY_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return queryAll(selectNotifiedRoleKeysStmt, NotifiedRoleKeySchema, { cutoff, profileId });
}

const updatePostingResultStmt = db.prepare(`
  UPDATE postings SET
    llm_relevant     = :llmRelevant,
    llm_reason       = :llmReason,
    llm_confidence   = :llmConfidence,
    yoe_min          = :yoeMin,
    yoe_max          = :yoeMax,
    drop_stage       = :dropStage,
    notified_at      = :notifiedAt,
    salary_min       = :salaryMin,
    salary_max       = :salaryMax,
    salary_currency  = :salaryCurrency,
    salary_period    = :salaryPeriod
  WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId
`);

export interface PostingResultUpdate {
  [key: string]: SQLInputValue;
  provider: Provider;
  externalId: string;
  profileId: string;
  llmRelevant: number | null;
  llmReason: string | null;
  llmConfidence: number | null;
  yoeMin: number | null;
  yoeMax: number | null;
  dropStage: string | null;
  notifiedAt: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
}

export function updatePostingResult(update: PostingResultUpdate): void {
  updatePostingResultStmt.run({
    ...update,
    salaryMin: update.salaryMin ?? null,
    salaryMax: update.salaryMax ?? null,
    salaryCurrency: update.salaryCurrency ?? null,
    salaryPeriod: update.salaryPeriod ?? null,
  });
}

const PostingSalarySchema = z.object({
  salary_min: z.number().nullable(),
  salary_max: z.number().nullable(),
  salary_currency: z.string().nullable(),
  salary_period: z.string().nullable(),
});

export interface PostingSalary {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}

const getPostingSalaryStmt = db.prepare(`
  SELECT salary_min, salary_max, salary_currency, salary_period
  FROM postings WHERE provider = :provider AND external_id = :externalId AND profile_id = :profileId
`);

export function getPostingSalary(provider: Provider, externalId: string, profileId: string): PostingSalary | undefined {
  const row = queryOne(getPostingSalaryStmt, PostingSalarySchema, { provider, externalId, profileId });
  if (!row) return undefined;
  return {
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    salaryPeriod: row.salary_period,
  };
}

const OutreachNotifiedPostingRowSchema = z.object({
  provider: ProviderSchema,
  company: z.string().nullable(),
  company_slug: z.string(),
  job_title: z.string().nullable(),
  job_url: z.string(),
  location: z.string().nullable(),
  llm_confidence: z.number().nullable(),
  drop_stage: z.string().nullable(),
});

export interface OutreachNotifiedPosting {
  provider: Provider;
  company: string;
  companySlug: string;
  jobTitle: string;
  jobUrl: string;
  location: string | null;
  llmConfidence: number | null;
  severity: Severity;
}

// A notified row has drop_stage NULL (green) or 'yellow'; company name comes from a join since postings stores only the slug.
// A posting the board no longer lists must never reach a fresh outreach draft.
const selectNotifiedPostingsSinceStmt = db.prepare(`
  SELECT p.provider, c.name AS company, p.company_slug, p.job_title, p.job_url,
         p.location, p.llm_confidence, p.drop_stage
  FROM postings p
  LEFT JOIN companies c ON c.provider = p.provider AND c.slug = p.company_slug
  WHERE p.notified_at IS NOT NULL
    AND p.notified_at >= :sinceIso
    AND p.profile_id = :profileId
    AND p.removed_at IS NULL
`);

export function selectNotifiedPostingsSince(sinceIso: string, profileId: string): OutreachNotifiedPosting[] {
  const rows = queryAll(selectNotifiedPostingsSinceStmt, OutreachNotifiedPostingRowSchema, {
    sinceIso,
    profileId,
  });
  return rows.map((r) => ({
    provider: r.provider,
    company: r.company ?? r.company_slug,
    companySlug: r.company_slug,
    jobTitle: r.job_title ?? "",
    jobUrl: r.job_url,
    location: r.location,
    llmConfidence: r.llm_confidence,
    severity: r.drop_stage === "yellow" ? "yellow" : "green",
  }));
}
