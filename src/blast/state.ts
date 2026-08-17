// JSON-file state for the TEMPORARY Raw Data blast tool. Deliberately not the job_hunter SQLite DB,
// so the whole blast can be deleted cleanly when the campaign ends.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../util/fs.js";

export const BlastStatusSchema = z.enum(["drafted", "bounced", "skipped_invalid"]);
export type BlastStatus = z.infer<typeof BlastStatusSchema>;

export const BlastRecordSchema = z.object({
  email: z.string(),
  company: z.string(),
  contactName: z.string().nullable(),
  status: BlastStatusSchema,
  /** 1-based weekly batch number this record was processed in. */
  batch: z.number().int(),
  /** e.g. "S2/O1" or "S2/O1-fallback"; null for skipped_invalid. */
  variant: z.string().nullable(),
  draftId: z.string().nullable(),
  at: z.string(),
  note: z.string().nullable(),
});
export type BlastRecord = z.infer<typeof BlastRecordSchema>;

export const BlastStateSchema = z.object({
  lastSweepAt: z.string().nullable(),
  records: z.array(BlastRecordSchema),
});
export type BlastState = z.infer<typeof BlastStateSchema>;

export function emptyState(): BlastState {
  return { lastSweepAt: null, records: [] };
}

export function statePathFor(profileId: string): string {
  return `data/blast-state-${profileId}.json`;
}

/** Missing file -> fresh empty state; malformed file throws (silently restarting would re-draft everyone). */
export function loadState(path: string): BlastState {
  if (!existsSync(path)) return emptyState();
  try {
    return BlastStateSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    throw new Error(`blast state at ${path} is unreadable: ${String(err)}`);
  }
}

/** Write-then-rename so a crash mid-write can't truncate the campaign state. */
export function saveState(path: string, state: BlastState): void {
  writeFileAtomic(path, JSON.stringify(state, null, 2));
}

/** All profiles' campaign states, sorted by profile id; a run by one profile must never wipe another's rows. */
export function loadAllStates(dir = "data"): { profileId: string; state: BlastState }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^blast-state-(.+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ profileId: m[1] ?? "", state: loadState(join(dir, m[0])) }))
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
}

export function knownEmails(state: BlastState): Set<string> {
  return new Set(state.records.map((r) => r.email));
}

/** Count of addresses ever drafted (still-drafted or later bounced); the rotation index base. */
export function draftedEverCount(state: BlastState): number {
  return state.records.filter((r) => r.status !== "skipped_invalid").length;
}

export function maxBatch(state: BlastState): number {
  return state.records.reduce((m, r) => Math.max(m, r.batch), 0);
}
