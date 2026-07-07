import { logger } from "../logger.js";
import { config } from "../config.js";
import { getDraft as getDraftDefault, searchMessages as searchMessagesDefault, getMessageMetadata as getMessageMetadataDefault, type MessageMetadata, type MessageRef } from "../google/gmail.js";
import { GoogleAuthExpiredError } from "../google/auth.js";
import {
  selectOutreachByStatus as selectOutreachByStatusDefault,
  updateOutreachStatus as updateOutreachStatusDefault,
  insertUndrafted as insertUndraftedDefault,
  type OutreachRow, type UpdateOutreachStatusInput, type InsertUndraftedInput,
} from "../db/outreach.js";
import { setRecruiterStatus as setRecruiterStatusDefault } from "../db/recruiters.js";
import { parseRoles } from "./roles.js";
import type { OutreachStatus, RecruiterStatus } from "../schemas.js";

/** Converts an ISO timestamp to integer epoch SECONDS. Gmail's `after:` search
 *  operator takes seconds, not milliseconds — passing ms silently returns a
 *  query anchored decades in the future and matches nothing. */
export function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export interface VerifyDeps {
  selectOutreachByStatus: (status: OutreachStatus, profileId?: string) => OutreachRow[];
  getDraft: (profileId: string, draftId: string) => Promise<"exists" | "gone">;
  searchMessages: (profileId: string, q: string) => Promise<MessageRef[]>;
  getMessageMetadata: (profileId: string, id: string) => Promise<MessageMetadata>;
  updateOutreachStatus: (input: UpdateOutreachStatusInput) => void;
  insertUndrafted: (row: InsertUndraftedInput) => void;
  setRecruiterStatus: (email: string, status: RecruiterStatus, atIso: string) => void;
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
    now: () => new Date(),
  };
}

export interface VerifyOptions {
  profileId: string;
  /** The CURRENT tick's run id — part of the call contract (mirrors runOutreach's
   *  options shape) but intentionally unused inside this pass: undrafted rows
   *  written on draft_discarded carry the row's ORIGINAL drafting run id
   *  (row.runId), not this one, so the sheet stays attributable to the run
   *  whose posting match produced the draft in the first place. */
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

/** Builds the Gmail search query for "did we send a message to this recipient
 *  after the draft was created". `after:` takes epoch seconds. */
function sentSearchQuery(recipientEmail: string, draftedAtIso: string): string {
  return `in:sent to:${recipientEmail} after:${epochSeconds(draftedAtIso)}`;
}

/** Builds the Gmail search query for a bounce notification addressed about
 *  this recipient, arriving after we sent to them. The recipient email is
 *  quoted so Gmail treats it as one phrase rather than tokenizing on '@'/'.'. */
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
    // No draft id was ever recorded (shouldn't happen for status='draft', but
    // there is nothing to check against Gmail) — just refresh last_checked_at.
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

  // Gone with no matching sent message: the draft was discarded (deleted from
  // the Gmail UI without sending). Discard does NOT reset the cooldown —
  // drafted_at stays untouched; only status + last_checked_at change here.
  deps.updateOutreachStatus({ id: row.id, status: "discarded", lastCheckedAt: nowIso });

  const roles = parseRoles(row.rolesJson);
  for (const role of roles) {
    deps.insertUndrafted({
      profileId: row.profileId,
      // Traceability choice: the undrafted row's runId/runDate point at the run
      // that ORIGINALLY drafted this outreach, not the verify pass's own run —
      // that keeps the sheet row attributable to the run whose posting match
      // produced it, matching how run.ts records undrafted rows at draft time.
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
    // Defensive: a 'sent' row without sent_at can't be checked meaningfully.
    deps.updateOutreachStatus({ id: row.id, status: "sent", lastCheckedAt: nowIso });
    return "unchanged";
  }

  const bounceHits = await deps.searchMessages(profileId, bounceSearchQuery(row.recruiterEmail, row.sentAt));
  if (bounceHits.length > 0) {
    const meta = await deps.getMessageMetadata(profileId, bounceHits[0]!.id);
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

/**
 * Bounce-only verification pass over one profile's mailbox. No reply reading,
 * no LLM judgment — purely: does the draft still exist, did a sent message
 * follow it, did a bounce notification follow a sent message, and has the
 * verifyAfterHours window elapsed. Must run BEFORE runOutreach in the daily
 * tick so yesterday's bounces gate today's drafts (src/index.ts wires this).
 */
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

  let bounced = 0;
  let verified = 0;

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
    else if (outcome === "verified") verified++;
  }

  return { checkedDrafts, sent, discarded, bounced, verified };
}
