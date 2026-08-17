import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { RecruiterStatusSchema, RecruiterSourceSchema } from "../schemas.js";
import type { RecruiterStatus, RecruiterSource } from "../schemas.js";
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

// Upsert never downgrades status/verified_at: 'bounced' is terminal against imports (only setRecruiterStatus can clear it),
// and an incoming 'unverified' never overwrites an existing verified/bounced row.
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

/** Insert or refresh a recruiter contact; never downgrades status/verified_at on re-import (see upsert SQL above). */
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

/** Sets a recruiter's global status; bounced -> verified is refused (a later profile's clean send must not resurrect an address another profile already bounced). */
export function setRecruiterStatus(email: string, status: RecruiterStatus, atIso: string): void {
  setRecruiterStatusStmt.run({ email: email.toLowerCase(), status, atIso });
}
