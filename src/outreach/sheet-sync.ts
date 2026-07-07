import { config } from "../config.js";
import { rewriteTab as rewriteTabDefault, appendRows as appendRowsDefault } from "../google/sheets.js";
import { selectOutreachByStatus, selectOutreachSentTab, type OutreachRow } from "../db/outreach.js";
import { selectUndraftedByRun, type UndraftedRow } from "../db/outreach.js";
import { logger } from "../logger.js";
import { DRAFTS_HEADER, SENT_HEADER, UNDRAFTED_HEADER } from "./tabs.js";
import { parseRoles, type RoleEntry } from "./roles.js";

function rolesCell(roles: RoleEntry[]): string {
  return roles.map((r) => `${r.title} — ${r.jobUrl}`).join("\n");
}

/** The role entry that should drive the row's Severity/Score columns: highest
 *  severity first (green beats yellow), then highest score within that tier. */
function maxSeverityRole(roles: RoleEntry[]): RoleEntry {
  return roles.reduce((best, r) => {
    if (r.severity === "green" && best.severity === "yellow") return r;
    if (r.severity === best.severity && (r.score ?? -Infinity) > (best.score ?? -Infinity)) return r;
    return best;
  });
}

function scoreCell(score: number | null): string {
  return score === null ? "" : String(score);
}

export interface SheetSyncDeps {
  rewriteTab: (profileId: string, tab: string, header: string[], rows: string[][]) => Promise<void>;
  appendRows: (profileId: string, tab: string, rows: string[][]) => Promise<void>;
}

function defaultDeps(): SheetSyncDeps {
  return { rewriteTab: rewriteTabDefault, appendRows: appendRowsDefault };
}

function draftRow(row: OutreachRow): string[] {
  const roles = parseRoles(row.rolesJson);
  const top = maxSeverityRole(roles);
  return [
    row.runDate,
    row.profileId,
    row.companyName,
    rolesCell(roles),
    top.severity,
    scoreCell(top.score),
    row.recruiterEmail,
    row.draftedAt,
    row.gmailDraftId ?? "",
  ];
}

function checkAfterIso(sentAtIso: string): string {
  return new Date(new Date(sentAtIso).getTime() + config.outreach.verifyAfterHours * 3_600_000).toISOString();
}

function sentRow(row: OutreachRow): string[] {
  const roles = parseRoles(row.rolesJson);
  return [
    row.runDate,
    row.profileId,
    row.companyName,
    rolesCell(roles),
    row.recruiterEmail,
    row.sentAt ?? "",
    row.sentAt ? checkAfterIso(row.sentAt) : "",
    row.status,
    row.lastCheckedAt ?? "",
  ];
}

function undraftedRow(row: UndraftedRow): string[] {
  return [
    row.runDate,
    row.profileId,
    row.company,
    row.jobTitle,
    row.location ?? "",
    row.jobUrl,
    row.severity,
    scoreCell(row.score),
    row.reason,
  ];
}

/**
 * Projects the current outreach DB state into the bot-managed sheet tabs:
 *   - Drafts: full rewrite, ALL profiles' status='draft' rows (global view).
 *   - Sent: full rewrite, ALL profiles' sent/bounced/verified rows, newest first.
 *   - Undrafted: APPEND only, scoped to THIS run's rows by runId (never by
 *     calendar date — two runs on the same IST day would re-append the first
 *     run's rows and duplicate them on the tab, since append never dedups).
 *
 * `profileId` addresses which profile's Google credentials make the API calls
 * (Sheets access is per-profile-token), not which rows are included.
 */
export async function projectToSheet(profileId: string, deps: SheetSyncDeps = defaultDeps(), runId?: number | null): Promise<void> {
  const drafts = selectOutreachByStatus("draft").map(draftRow);
  await deps.rewriteTab(profileId, config.google.tabs.drafts, [...DRAFTS_HEADER], drafts);

  const sent = selectOutreachSentTab().map(sentRow);
  await deps.rewriteTab(profileId, config.google.tabs.sent, [...SENT_HEADER], sent);

  if (runId !== undefined && runId !== null) {
    const undrafted = selectUndraftedByRun(runId).map(undraftedRow);
    if (undrafted.length > 0) {
      await deps.appendRows(profileId, config.google.tabs.undrafted, undrafted);
    }
  } else {
    logger.warn("sheet-sync: no runId — skipping Undrafted append (rows stay in DB only)");
  }
}
