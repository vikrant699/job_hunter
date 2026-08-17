import { logger } from "../logger.js";
import { config } from "../config.js";
import { getDraft as getDraftDefault, searchMessages as searchMessagesDefault, getMessageMetadata as getMessageMetadataDefault } from "../google/gmail.js";
import type { MessageMetadata, MessageRef } from "../google/gmail.js";
import { GoogleAuthExpiredError } from "../google/auth.js";
import { selectOutreachByStatus as selectOutreachByStatusDefault, updateOutreachStatus as updateOutreachStatusDefault, insertUndrafted as insertUndraftedDefault } from "../db/outreach.js";
import type { OutreachRow, UpdateOutreachStatusInput, InsertUndraftedInput } from "../db/outreach.js";
import { selectAllRecruiters, setRecruiterStatus as setRecruiterStatusDefault } from "../db/recruiters.js";
import { readTab as readTabDefault, appendRows as appendRowsDefault } from "../google/sheets.js";
import { parseRoles } from "./roles.js";
import { istDate } from "./run.js";
import { RECRUITERS_LIST_COLS } from "./tabs.js";
import type { OutreachStatus, RecruiterStatus, RecruiterSource } from "../schemas.js";

/** How far back the verify pass re-checks 'discarded' rows for a late-indexed sent message. */
const DISCARDED_RECHECK_DAYS = 14;

/** Gmail's `after:` takes epoch seconds, not ms; passing ms anchors the query decades in the future. */
export function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Minimal recruiter lookup verify.ts needs, avoiding the full RecruiterRow shape. */
export interface VerifyRecruiterLookup {
  email: string;
  company: string;
  contactName: string | null;
  phone: string | null;
  source: RecruiterSource;
  /** Live status at lookup time; setRecruiterStatus refuses bounced->verified, so a row marked
   *  'verified' here can still belong to a globally-bounced recruiter. */
  status: RecruiterStatus;
  registrySlug: string | null;
}

export interface VerifyDeps {
  selectOutreachByStatus: (status: OutreachStatus, profileId?: string) => OutreachRow[];
  getDraft: (profileId: string, draftId: string) => Promise<"exists" | "gone">;
  searchMessages: (profileId: string, q: string) => Promise<MessageRef[]>;
  getMessageMetadata: (profileId: string, id: string) => Promise<MessageMetadata>;
  updateOutreachStatus: (input: UpdateOutreachStatusInput) => void;
  insertUndrafted: (row: InsertUndraftedInput) => void;
  setRecruiterStatus: (email: string, status: RecruiterStatus, atIso: string) => void;
  lookupRecruiter: (email: string) => VerifyRecruiterLookup | null;
  readTab: (profileId: string, tab: string) => Promise<string[][]>;
  appendRows: (profileId: string, tab: string, rows: string[][]) => Promise<void>;
  now: () => Date;
}

function defaultDeps(): VerifyDeps {
  return {
    selectOutreachByStatus: selectOutreachByStatusDefault,
    getDraft: getDraftDefault,
    searchMessages: searchMessagesDefault,
    getMessageMetadata: getMessageMetadataDefault,
    updateOutreachStatus: updateOutreachStatusDefault,
    insertUndrafted: insertUndraftedDefault,
    setRecruiterStatus: setRecruiterStatusDefault,
    lookupRecruiter: defaultLookupRecruiter,
    readTab: defaultReadTab,
    appendRows: defaultAppendRows,
    now: () => new Date(),
  };
}

function defaultLookupRecruiter(email: string): VerifyRecruiterLookup | null {
  const row = selectAllRecruiters().find((r) => r.email === email.toLowerCase());
  if (!row) return null;
  return {
    email: row.email,
    company: row.company,
    contactName: row.contactName,
    phone: row.phone,
    source: row.source,
    status: row.status,
    registrySlug: row.registrySlug,
  };
}

function defaultReadTab(profileId: string, tab: string): Promise<string[][]> {
  return readTabDefault(profileId, tab);
}

function defaultAppendRows(profileId: string, tab: string, rows: string[][]): Promise<void> {
  return appendRowsDefault(profileId, tab, rows);
}

export interface VerifyOptions {
  profileId: string;
  /** Unused inside this pass: undrafted rows on draft_discarded carry the row's original drafting runId, not this one. */
  runId: number | null;
  deps?: Partial<VerifyDeps>;
}

export interface VerifyResult {
  checkedDrafts: number;
  sent: number;
  discarded: number;
  bounced: number;
  verified: number;
}

/** Gmail query for "did we send a message to this recipient after the draft was created". */
function sentSearchQuery(recipientEmail: string, draftedAtIso: string): string {
  return `in:sent to:${recipientEmail} after:${epochSeconds(draftedAtIso)}`;
}

/** Gmail query for a bounce notification about this recipient, arriving after we sent; quoted so Gmail treats it as one phrase. */
function bounceSearchQuery(recipientEmail: string, sentAtIso: string): string {
  return `from:(mailer-daemon OR postmaster) "${recipientEmail}" after:${epochSeconds(sentAtIso)}`;
}

/** Picks the newest message ref by internalDate (ms) among metadata-fetched hits. */
async function newestMessage(
  deps: VerifyDeps,
  profileId: string,
  hits: MessageRef[],
): Promise<{ id: string; internalDate: number } | null> {
  let best: { id: string; internalDate: number } | null = null;
  for (const hit of hits) {
    const meta = await deps.getMessageMetadata(profileId, hit.id);
    if (best === null || meta.internalDate > best.internalDate) {
      best = { id: hit.id, internalDate: meta.internalDate };
    }
  }
  return best;
}

async function resolveDraftRow(
  deps: VerifyDeps,
  profileId: string,
  row: OutreachRow,
  nowIso: string,
): Promise<"unchanged" | "sent" | "discarded"> {
  if (row.gmailDraftId === null) {
    // Nothing to check against Gmail; just refresh last_checked_at.
    deps.updateOutreachStatus({ id: row.id, status: "draft", lastCheckedAt: nowIso });
    return "unchanged";
  }

  const draftState = await deps.getDraft(profileId, row.gmailDraftId);
  if (draftState === "exists") {
    deps.updateOutreachStatus({ id: row.id, status: "draft", lastCheckedAt: nowIso });
    return "unchanged";
  }

  const hits = await deps.searchMessages(profileId, sentSearchQuery(row.recruiterEmail, row.draftedAt));
  if (hits.length > 0) {
    const newest = await newestMessage(deps, profileId, hits);
    if (newest !== null) {
      deps.updateOutreachStatus({
        id: row.id,
        status: "sent",
        sentAt: new Date(newest.internalDate).toISOString(),
        gmailMessageId: newest.id,
        lastCheckedAt: nowIso,
      });
      return "sent";
    }
  }

  // Gone with no matching sent message means the draft was deleted unsent; discard does not reset the cooldown.
  deps.updateOutreachStatus({ id: row.id, status: "discarded", lastCheckedAt: nowIso });

  const roles = parseRoles(row.rolesJson);
  for (const role of roles) {
    deps.insertUndrafted({
      profileId: row.profileId,
      // runId/runDate point at the run that originally drafted this, not the verify pass's own run.
      runId: row.runId,
      runDate: row.runDate,
      company: row.companyName,
      jobTitle: role.title,
      location: null,
      jobUrl: role.jobUrl,
      severity: role.severity,
      score: role.score,
      reason: "draft_discarded",
    });
  }
  return "discarded";
}

async function resolveSentRow(
  deps: VerifyDeps,
  profileId: string,
  row: OutreachRow,
  now: Date,
): Promise<"unchanged" | "bounced" | "verified"> {
  const nowIso = now.toISOString();
  if (row.sentAt === null) {
    deps.updateOutreachStatus({ id: row.id, status: "sent", lastCheckedAt: nowIso });
    return "unchanged";
  }

  const bounceHits = await deps.searchMessages(profileId, bounceSearchQuery(row.recruiterEmail, row.sentAt));
  if (bounceHits.length > 0) {
    const first = bounceHits[0];
    if (!first) return "unchanged";
    const meta = await deps.getMessageMetadata(profileId, first.id);
    deps.updateOutreachStatus({
      id: row.id,
      status: "bounced",
      failureDetail: meta.snippet,
      lastCheckedAt: nowIso,
    });
    deps.setRecruiterStatus(row.recruiterEmail, "bounced", nowIso);
    return "bounced";
  }

  const verifyDeadlineMs = new Date(row.sentAt).getTime() + config.outreach.verifyAfterHours * 3_600_000;
  if (now.getTime() >= verifyDeadlineMs) {
    deps.updateOutreachStatus({
      id: row.id,
      status: "verified",
      verifiedAt: nowIso,
      lastCheckedAt: nowIso,
    });
    deps.setRecruiterStatus(row.recruiterEmail, "verified", nowIso);
    return "verified";
  }

  deps.updateOutreachStatus({ id: row.id, status: "sent", lastCheckedAt: nowIso });
  return "unchanged";
}

// Bounce-only verification: draft exists? sent message followed? bounce followed sent? verifyAfterHours elapsed?
// Must run before runOutreach in the daily tick so yesterday's bounces gate today's drafts.
export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const deps: VerifyDeps = { ...defaultDeps(), ...options.deps };
  const { profileId } = options;
  const now = deps.now();
  const nowIso = now.toISOString();

  let sent = 0;
  let discarded = 0;
  let checkedDrafts = 0;

  const draftRows = deps.selectOutreachByStatus("draft", profileId);
  for (const row of draftRows) {
    let outcome: "unchanged" | "sent" | "discarded";
    try {
      outcome = await resolveDraftRow(deps, profileId, row, nowIso);
    } catch (err) {
      if (err instanceof GoogleAuthExpiredError) throw err;
      logger.error({ err: String(err), outreachId: row.id, recruiter: row.recruiterEmail }, "verify: draft check failed; continuing");
      continue;
    }
    checkedDrafts++;
    if (outcome === "sent") sent++;
    else if (outcome === "discarded") discarded++;
  }

  // Gmail's search index can lag a just-sent message, misclassifying a sent draft as discarded;
  // re-check recent discarded rows for a late-appearing sent hit and recover them.
  const recheckCutoffMs = now.getTime() - DISCARDED_RECHECK_DAYS * 24 * 3_600_000;
  const discardedRows = deps.selectOutreachByStatus("discarded", profileId);
  for (const row of discardedRows) {
    if (new Date(row.draftedAt).getTime() < recheckCutoffMs) continue;
    try {
      const hits = await deps.searchMessages(profileId, sentSearchQuery(row.recruiterEmail, row.draftedAt));
      if (hits.length === 0) continue;
      const newest = await newestMessage(deps, profileId, hits);
      if (newest === null) continue;
      deps.updateOutreachStatus({
        id: row.id,
        status: "sent",
        sentAt: new Date(newest.internalDate).toISOString(),
        gmailMessageId: newest.id,
        lastCheckedAt: nowIso,
      });
      logger.info({ outreachId: row.id, recruiter: row.recruiterEmail }, "verify: discarded row recovered to sent (late search hit)");
      sent++;
    } catch (err) {
      if (err instanceof GoogleAuthExpiredError) throw err;
      logger.error({ err: String(err), outreachId: row.id }, "verify: discarded recheck failed; continuing");
    }
  }

  let bounced = 0;
  let verified = 0;
  const newlyVerifiedRawCsv: OutreachRow[] = [];

  const sentRows = deps.selectOutreachByStatus("sent", profileId);
  for (const row of sentRows) {
    let outcome: "unchanged" | "bounced" | "verified";
    try {
      outcome = await resolveSentRow(deps, profileId, row, now);
    } catch (err) {
      if (err instanceof GoogleAuthExpiredError) throw err;
      logger.error({ err: String(err), outreachId: row.id, recruiter: row.recruiterEmail }, "verify: sent-row check failed; continuing");
      continue;
    }
    if (outcome === "bounced") bounced++;
    else if (outcome === "verified") {
      verified++;
      newlyVerifiedRawCsv.push(row);
    }
  }

  if (newlyVerifiedRawCsv.length > 0) {
    await promoteNewlyVerified(deps, profileId, newlyVerifiedRawCsv, now);
  }

  return { checkedDrafts, sent, discarded, bounced, verified };
}

/** Splits "Company/Email" style cells the same way contacts.ts does. */
function splitTabEmails(cell: string): string[] {
  return cell
    .split(/[/,]/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** Appends newly-verified raw-csv-sourced recruiters to the Recruiters List tab if not already there. */
async function promoteNewlyVerified(deps: VerifyDeps, profileId: string, newlyVerified: OutreachRow[], now: Date): Promise<void> {
  const candidates = newlyVerified
    .map((row) => deps.lookupRecruiter(row.recruiterEmail))
    .filter((r): r is VerifyRecruiterLookup => r !== null && r.source === "raw-csv" && r.status === "verified");
  if (candidates.length === 0) return;

  const existingRows = await deps.readTab(profileId, config.google.tabs.recruiters);
  const existingEmails = new Set<string>();
  for (const row of existingRows.slice(1)) {
    for (const email of splitTabEmails(row[RECRUITERS_LIST_COLS.email] ?? "")) {
      existingEmails.add(email);
    }
  }

  const seenThisPass = new Set<string>();
  const rowsToAppend: string[][] = [];
  for (const c of candidates) {
    const email = c.email.toLowerCase();
    if (existingEmails.has(email) || seenThisPass.has(email)) continue;
    seenThisPass.add(email);
    rowsToAppend.push([
      c.company,
      c.contactName ?? "",
      c.phone ?? "",
      email,
      "job-hunter-bot",
      istDate(now),
      c.registrySlug ?? "",
    ]);
  }

  if (rowsToAppend.length > 0) {
    await deps.appendRows(profileId, config.google.tabs.recruiters, rowsToAppend);
  }
}
