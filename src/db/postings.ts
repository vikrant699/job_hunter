import { type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { NormalizedPosting } from "../types.js";
import type { Provider } from "../schemas.js";
import { db, queryAll } from "./db.js";

/* ===== Statements ===== */

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

/* ===== selectNotifiedRoleKeys ===== */

const NotifiedRoleKeySchema = z.object({
  company: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
});

const selectNotifiedRoleKeysStmt = db.prepare(`
  SELECT c.name AS company, p.job_title AS title, p.location AS location
  FROM postings p
  LEFT JOIN companies c ON c.provider = p.provider AND c.slug = p.company_slug
  WHERE p.notified_at IS NOT NULL
`);

/**
 * Every (company name, title, location) tuple we've ever notified. Used to dedupe
 * re-listed roles ACROSS runs: a repost gets a fresh external_id, so postingExists
 * misses it, but the role is unchanged — we shouldn't ping it again.
 */
export function selectNotifiedRoleKeys(): Array<{
  company: string | null;
  title: string | null;
  location: string | null;
}> {
  return queryAll(selectNotifiedRoleKeysStmt, NotifiedRoleKeySchema);
}

/* ===== updatePostingResult ===== */

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

/* ===== listNotifiedPostingsSince ===== */

const NotifiedPostingRowSchema = z.object({
  company: z.string().nullable(),
  company_slug: z.string(),
  job_title: z.string().nullable(),
  job_url: z.string(),
  llm_confidence: z.number().nullable(),
  drop_stage: z.string().nullable(),
  llm_reason: z.string().nullable(),
});

export interface NotifiedPosting {
  company: string;
  title: string;
  url: string;
  score: number | null;
  tier: "green" | "yellow";
  reason: string;
}

// Notified postings (green = drop_stage NULL, yellow = drop_stage 'yellow')
// discovered this tick, joined to the company name. Green first, then score desc.
const listNotifiedPostingsSinceStmt = db.prepare(`
  SELECT c.name AS company, p.company_slug, p.job_title, p.job_url,
         p.llm_confidence, p.drop_stage, p.llm_reason
  FROM postings p
  LEFT JOIN companies c ON c.provider = p.provider AND c.slug = p.company_slug
  WHERE p.discovered_at >= :since
    AND p.notified_at IS NOT NULL
    AND (p.drop_stage IS NULL OR p.drop_stage = 'yellow')
  ORDER BY CASE WHEN p.drop_stage IS NULL THEN 0 ELSE 1 END,
           p.llm_confidence DESC
`);

export function listNotifiedPostingsSince(sinceIso: string): NotifiedPosting[] {
  const rows = queryAll(listNotifiedPostingsSinceStmt, NotifiedPostingRowSchema, {
    since: sinceIso,
  });
  return rows.map((r) => ({
    company: r.company ?? r.company_slug,
    title: r.job_title ?? "",
    url: r.job_url,
    score: r.llm_confidence,
    tier: r.drop_stage === "yellow" ? "yellow" : "green",
    reason: r.llm_reason ?? "",
  }));
}
