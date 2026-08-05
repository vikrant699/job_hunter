import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { OutreachStatusSchema, UndraftedReasonSchema } from "../schemas.js";
import type { OutreachStatus, UndraftedReason } from "../schemas.js";
import { db, queryAll, queryOne } from "./db.js";

/* ===== outreach ===== */

const OutreachRowSchema = z.object({
  id: z.number(),
  profile_id: z.string(),
  recruiter_email: z.string(),
  company_name: z.string(),
  roles_json: z.string(),
  run_id: z.number().nullable(),
  run_date: z.string(),
  gmail_draft_id: z.string().nullable(),
  gmail_thread_id: z.string().nullable(),
  gmail_message_id: z.string().nullable(),
  status: OutreachStatusSchema,
  drafted_at: z.string(),
  sent_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  failure_detail: z.string().nullable(),
});

export type OutreachDbRow = z.infer<typeof OutreachRowSchema>;

export interface OutreachRow {
  id: number;
  profileId: string;
  recruiterEmail: string;
  companyName: string;
  rolesJson: string;
  runId: number | null;
  runDate: string;
  gmailDraftId: string | null;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  status: OutreachStatus;
  draftedAt: string;
  sentAt: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  failureDetail: string | null;
}

function rowToOutreach(r: OutreachDbRow): OutreachRow {
  return {
    id: r.id,
    profileId: r.profile_id,
    recruiterEmail: r.recruiter_email,
    companyName: r.company_name,
    rolesJson: r.roles_json,
    runId: r.run_id,
    runDate: r.run_date,
    gmailDraftId: r.gmail_draft_id,
    gmailThreadId: r.gmail_thread_id,
    gmailMessageId: r.gmail_message_id,
    status: r.status,
    draftedAt: r.drafted_at,
    sentAt: r.sent_at,
    verifiedAt: r.verified_at,
    lastCheckedAt: r.last_checked_at,
    failureDetail: r.failure_detail,
  };
}

const insertOutreachStmt = db.prepare(`
  INSERT INTO outreach (
    profile_id, recruiter_email, company_name, roles_json, run_id, run_date,
    gmail_draft_id, gmail_thread_id, gmail_message_id, status, drafted_at,
    sent_at, verified_at, last_checked_at, failure_detail
  ) VALUES (
    :profileId, :recruiterEmail, :companyName, :rolesJson, :runId, :runDate,
    :gmailDraftId, :gmailThreadId, :gmailMessageId, :status, :draftedAt,
    :sentAt, :verifiedAt, :lastCheckedAt, :failureDetail
  )
`);

export interface InsertOutreachInput {
  [key: string]: SQLInputValue;
  profileId: string;
  recruiterEmail: string;
  companyName: string;
  rolesJson: string;
  runId: number | null;
  runDate: string;
  gmailDraftId: string | null;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  status: OutreachStatus;
  draftedAt: string;
  sentAt: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  failureDetail: string | null;
}

/** Inserts a new outreach attempt row, returning its id. */
export function insertOutreach(row: InsertOutreachInput): number {
  const result = insertOutreachStmt.run(row);
  return Number(result.lastInsertRowid);
}

const selectOutreachByStatusStmt = db.prepare(`
  SELECT * FROM outreach WHERE status = :status
`);

const selectOutreachByStatusAndProfileStmt = db.prepare(`
  SELECT * FROM outreach WHERE status = :status AND profile_id = :profileId
`);

export function selectOutreachByStatus(status: OutreachStatus, profileId?: string): OutreachRow[] {
  const rows =
    profileId === undefined
      ? queryAll(selectOutreachByStatusStmt, OutreachRowSchema, { status })
      : queryAll(selectOutreachByStatusAndProfileStmt, OutreachRowSchema, { status, profileId });
  return rows.map(rowToOutreach);
}

const selectOutreachSentTabStmt = db.prepare(`
  SELECT * FROM outreach
  WHERE status IN ('sent', 'bounced', 'verified')
  ORDER BY sent_at DESC
`);

/** Every outreach row that has moved past 'draft' (sent, bounced, or
 *  verified), across ALL profiles, newest sent_at first. Feeds the Sent
 *  sheet-tab projection, which shows global state rather than one profile. */
export function selectOutreachSentTab(): OutreachRow[] {
  return queryAll(selectOutreachSentTabStmt, OutreachRowSchema).map(rowToOutreach);
}

// Patch semantics: COALESCE falls back to the existing column value whenever the
// caller passes null for a field it isn't updating. This means a genuine "clear
// this field back to null" is not expressible through this function — none of
// the current callers need that, and status/id are always required so the row
// is always addressable.
const updateOutreachStatusStmt = db.prepare(`
  UPDATE outreach SET
    status           = :status,
    sent_at          = COALESCE(:sentAt, sent_at),
    verified_at      = COALESCE(:verifiedAt, verified_at),
    last_checked_at  = COALESCE(:lastCheckedAt, last_checked_at),
    gmail_message_id = COALESCE(:gmailMessageId, gmail_message_id),
    failure_detail   = COALESCE(:failureDetail, failure_detail)
  WHERE id = :id
`);

export interface UpdateOutreachStatusInput {
  id: number;
  status: OutreachStatus;
  sentAt?: string | null;
  verifiedAt?: string | null;
  lastCheckedAt?: string | null;
  gmailMessageId?: string | null;
  failureDetail?: string | null;
}

/** Patch-updates an outreach row's status plus any provided fields. Fields left
 *  undefined/omitted are coalesced to their current DB value (unchanged). */
export function updateOutreachStatus(input: UpdateOutreachStatusInput): void {
  updateOutreachStatusStmt.run({
    id: input.id,
    status: input.status,
    sentAt: input.sentAt ?? null,
    verifiedAt: input.verifiedAt ?? null,
    lastCheckedAt: input.lastCheckedAt ?? null,
    gmailMessageId: input.gmailMessageId ?? null,
    failureDetail: input.failureDetail ?? null,
  });
}

const LastDraftedAtSchema = z.object({ maxDraftedAt: z.string().nullable() });

const selectLastDraftedAtStmt = db.prepare(`
  SELECT MAX(drafted_at) AS maxDraftedAt FROM outreach
  WHERE recruiter_email = :email AND profile_id = :profileId
`);

/** MAX(drafted_at) for this (recruiter, profile) pair, or null if never drafted. */
export function selectLastDraftedAt(email: string, profileId: string): string | null {
  const row = queryOne(selectLastDraftedAtStmt, LastDraftedAtSchema, { email, profileId });
  return row?.maxDraftedAt ?? null;
}

/* ===== undrafted ===== */

const UndraftedRowSchema = z.object({
  id: z.number(),
  profile_id: z.string(),
  run_id: z.number().nullable(),
  run_date: z.string(),
  company: z.string(),
  job_title: z.string(),
  location: z.string().nullable(),
  job_url: z.string(),
  severity: z.string(),
  score: z.number().nullable(),
  reason: UndraftedReasonSchema,
});

export type UndraftedDbRow = z.infer<typeof UndraftedRowSchema>;

export interface UndraftedRow {
  id: number;
  profileId: string;
  runId: number | null;
  runDate: string;
  company: string;
  jobTitle: string;
  location: string | null;
  jobUrl: string;
  severity: string;
  score: number | null;
  reason: UndraftedReason;
}

function rowToUndrafted(r: UndraftedDbRow): UndraftedRow {
  return {
    id: r.id,
    profileId: r.profile_id,
    runId: r.run_id,
    runDate: r.run_date,
    company: r.company,
    jobTitle: r.job_title,
    location: r.location,
    jobUrl: r.job_url,
    severity: r.severity,
    score: r.score,
    reason: r.reason,
  };
}

const insertUndraftedStmt = db.prepare(`
  INSERT INTO undrafted (
    profile_id, run_id, run_date, company, job_title, location, job_url,
    severity, score, reason
  ) VALUES (
    :profileId, :runId, :runDate, :company, :jobTitle, :location, :jobUrl,
    :severity, :score, :reason
  )
`);

export interface InsertUndraftedInput {
  [key: string]: SQLInputValue;
  profileId: string;
  runId: number | null;
  runDate: string;
  company: string;
  jobTitle: string;
  location: string | null;
  jobUrl: string;
  severity: string;
  score: number | null;
  reason: UndraftedReason;
}

export function insertUndrafted(row: InsertUndraftedInput): void {
  insertUndraftedStmt.run(row);
}

const selectUndraftedByRunStmt = db.prepare(`
  SELECT * FROM undrafted WHERE run_id = :runId
`);

export function selectUndraftedByRun(runId: number): UndraftedRow[] {
  return queryAll(selectUndraftedByRunStmt, UndraftedRowSchema, { runId }).map(rowToUndrafted);
}
