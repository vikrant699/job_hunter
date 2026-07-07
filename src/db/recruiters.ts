import { type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { RecruiterStatusSchema, RecruiterSourceSchema, type RecruiterStatus, type RecruiterSource } from "../schemas.js";
import { db, queryAll } from "./db.js";

/* ===== Row schema ===== */

const RecruiterRowSchema = z.object({
  email: z.string(),
  company: z.string(),
  company_norm: z.string(),
  alt_names_norm: z.string().nullable(),
  contact_name: z.string().nullable(),
  phone: z.string().nullable(),
  source: RecruiterSourceSchema,
  registry_provider: z.string().nullable(),
  registry_slug: z.string().nullable(),
  status: RecruiterStatusSchema,
  verified_at: z.string().nullable(),
  imported_at: z.string(),
});

export type RecruiterDbRow = z.infer<typeof RecruiterRowSchema>;

/** Camel-cased view of a recruiter row, used everywhere outside this module
 *  (including src/outreach/match.ts, which imports only this type). */
export interface RecruiterRow {
  email: string;
  company: string;
  companyNorm: string;
  altNamesNorm: string | null;
  contactName: string | null;
  phone: string | null;
  source: RecruiterSource;
  registryProvider: string | null;
  registrySlug: string | null;
  status: RecruiterStatus;
  verifiedAt: string | null;
  importedAt: string;
}

function rowToRecruiter(r: RecruiterDbRow): RecruiterRow {
  return {
    email: r.email,
    company: r.company,
    companyNorm: r.company_norm,
    altNamesNorm: r.alt_names_norm,
    contactName: r.contact_name,
    phone: r.phone,
    source: r.source,
    registryProvider: r.registry_provider,
    registrySlug: r.registry_slug,
    status: r.status,
    verifiedAt: r.verified_at,
    importedAt: r.imported_at,
  };
}

/* ===== Statements ===== */

// Upsert never DOWNGRADES bot-managed fields. Two rules, in priority order:
//   1. 'bounced' is terminal against imports — a dead address stays dead even if
//      it still sits in the manual Recruiters List tab (which imports rows as
//      'verified'; without this rule the next sync would resurrect it and the
//      bot would draft to a known-bouncing mailbox). Only setRecruiterStatus
//      (the verify pipeline) can move a row out of 'bounced'.
//   2. An incoming 'unverified' (raw-csv re-import) never overwrites an existing
//      verified/bounced status.
// verified_at follows the same rules so re-imports can't wipe the timestamp.
const upsertRecruiterStmt = db.prepare(`
  INSERT INTO recruiters (
    email, company, company_norm, alt_names_norm, contact_name, phone,
    source, registry_provider, registry_slug, status, verified_at, imported_at
  ) VALUES (
    :email, :company, :companyNorm, :altNamesNorm, :contactName, :phone,
    :source, :registryProvider, :registrySlug, :status, :verifiedAt, :importedAt
  )
  ON CONFLICT(email) DO UPDATE SET
    company           = excluded.company,
    company_norm      = excluded.company_norm,
    alt_names_norm    = excluded.alt_names_norm,
    contact_name      = excluded.contact_name,
    phone             = excluded.phone,
    source            = excluded.source,
    registry_provider = excluded.registry_provider,
    registry_slug     = excluded.registry_slug,
    status            = CASE
                           WHEN recruiters.status = 'bounced' THEN recruiters.status
                           WHEN excluded.status = 'unverified' THEN recruiters.status
                           ELSE excluded.status
                         END,
    verified_at       = CASE
                           WHEN recruiters.status = 'bounced' THEN recruiters.verified_at
                           WHEN excluded.status = 'unverified' THEN recruiters.verified_at
                           ELSE excluded.verified_at
                         END
`);

export interface UpsertRecruiterInput {
  [key: string]: SQLInputValue;
  email: string;
  company: string;
  companyNorm: string;
  altNamesNorm: string | null;
  contactName: string | null;
  phone: string | null;
  source: RecruiterSource;
  registryProvider: string | null;
  registrySlug: string | null;
  status: RecruiterStatus;
  verifiedAt: string | null;
  importedAt: string;
}

/** Insert or refresh a recruiter contact. Never downgrades `status`/`verified_at`
 *  on re-import: an existing 'bounced' row keeps its status even against an
 *  incoming 'verified' (stale manual-sheet row), and an incoming 'unverified'
 *  never overwrites verified/bounced. All other fields refresh. */
export function upsertRecruiter(row: UpsertRecruiterInput): void {
  upsertRecruiterStmt.run({ ...row, email: row.email.toLowerCase() });
}

const selectAllRecruitersStmt = db.prepare(`SELECT * FROM recruiters`);

export function selectAllRecruiters(): RecruiterRow[] {
  return queryAll(selectAllRecruitersStmt, RecruiterRowSchema).map(rowToRecruiter);
}

const selectRecruitersByCompanyNormStmt = db.prepare(`
  SELECT * FROM recruiters WHERE company_norm = :companyNorm
`);

export function selectRecruitersByCompanyNorm(companyNorm: string): RecruiterRow[] {
  return queryAll(selectRecruitersByCompanyNormStmt, RecruiterRowSchema, { companyNorm }).map(rowToRecruiter);
}

const setRecruiterStatusStmt = db.prepare(`
  UPDATE recruiters SET
    status      = :status,
    verified_at = CASE WHEN :status = 'verified' THEN :atIso ELSE verified_at END
  WHERE email = :email
    AND NOT (status = 'bounced' AND :status = 'verified')
`);

/** Sets a recruiter's global status. `verified_at` is stamped only when the new
 *  status is 'verified'; transitioning to 'unverified' or 'bounced' leaves any
 *  existing verified_at as-is (it records the original verification time).
 *  bounced -> verified is REFUSED: with per-profile mailboxes, one profile's
 *  24h-clean window can elapse after another profile's send already bounced,
 *  and a verified overwrite would put a dead address back into rotation (and
 *  onto the Recruiters List tab via promotion). Dead is dead. */
export function setRecruiterStatus(email: string, status: RecruiterStatus, atIso: string): void {
  setRecruiterStatusStmt.run({ email: email.toLowerCase(), status, atIso });
}
