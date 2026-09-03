import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { NormalizedPosting } from "../types.js";
import type { Provider, Severity } from "../schemas.js";
import { ProviderSchema } from "../schemas.js";
import { db, queryAll, queryOne } from "./db.js";

// p.jdText is deliberately not persisted: the gate consumes it in-memory and nothing reads it back afterwards.
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

/** Returns true if the row was inserted (i.e. a new posting). */
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

// node:sqlite has no array-bind for IN(...), so the placeholder list is built per call, chunked under SQLite's ~999-parameter cap.
const SEEN_CHUNK_SIZE = 500;

/** Bumps last_seen_at (and revives - clears removed_at) for exactly the externalIds a successful listing fetch returned; callers pass the FULL listing since "seen" doesn't depend on relevance. */
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

/** Marks every not-yet-removed row of this board with last_seen_at before fetchStartedAt as removed; that bound protects a parallel company's freshly-inserted rows - never widen this WHERE. */
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

/** How many rows of this board were freshly inserted (discovered_at >= sinceIso); avoids threading a counter through the per-posting pipeline. */
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

/** Count of notified postings (same window as selectNotifiedPostingsSince) excluded because the board no longer lists them; feeds the outreach stage's exclusion log. */
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

// A role re-posted after this long is worth a fresh ping; also bounds the in-memory dedup set from growing unboundedly with notify history.
const NOTIFY_DEDUP_WINDOW_DAYS = 180;

/** Every (company, title, location) tuple notified in the last 180 days; dedupes reposts, which get a fresh external_id and would otherwise slip past postingExists. */
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
  // Annualized (src/filter/salary.ts); optional (defaults to null) so pre-existing callers compile unchanged.
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

/** The stored (annualized) salary columns for one posting - audit/test read-back; nothing in the pipeline itself reads this back. */
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

// drop_stage NULL -> green, 'yellow' -> yellow (the only two values a notified row can carry); company display name comes from a join since postings only stores the slug.
// removed_at IS NULL: a posting the board no longer lists must never reach a fresh outreach draft.
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

/** Postings notified since `sinceIso` for `profileId`, joined to company display name (falls back to slug). Feeds the outreach draft stage. */
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
