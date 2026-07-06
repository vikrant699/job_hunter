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

// Upsert never DOWNGRADES bot-managed fields: status only moves to the incoming
// value when the incoming status is NOT 'unverified' (i.e. a plain re-import,
// which always proposes 'unverified' for raw-csv or 'verified' for manual-sheet,
// can upgrade unverified -> verified/bounced-preserving but never overwrite an
// existing verified/bounced row back down to unverified). verified_at follows
// the same rule so a re-import can't wipe the original verification timestamp.
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
                           WHEN excluded.status = 'unverified' THEN recruiters.status
                           ELSE excluded.status
                         END,
    verified_at       = CASE
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
 *  on re-import: an incoming 'unverified' status leaves an existing verified or
 *  bounced row's status (and verified_at) untouched. All other fields refresh. */
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
`);

/** Sets a recruiter's global status. `verified_at` is stamped only when the new
 *  status is 'verified'; transitioning to 'unverified' or 'bounced' leaves any
 *  existing verified_at as-is (it records the original verification time). */
export function setRecruiterStatus(email: string, status: RecruiterStatus, atIso: string): void {
  setRecruiterStatusStmt.run({ email: email.toLowerCase(), status, atIso });
}
