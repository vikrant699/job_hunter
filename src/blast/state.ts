// src/blast/state.ts
//
// JSON-file state for the TEMPORARY Raw Data blast tool
// (docs/superpowers/specs/2026-07-09-divya-blast-design.md). Deliberately NOT
// the job_hunter SQLite DB: the whole blast lives in src/blast/ + one state
// file so it can be deleted cleanly when the campaign ends.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

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

/** Missing file -> fresh empty state. Malformed file -> throw: silently
 *  restarting the campaign would re-draft every address in the tab. */
export function loadState(path: string): BlastState {
  if (!existsSync(path)) return emptyState();
  return BlastStateSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

/** Write-then-rename so a crash mid-write can't truncate the campaign state. */
export function saveState(path: string, state: BlastState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-blast`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function knownEmails(state: BlastState): Set<string> {
  return new Set(state.records.map((r) => r.email));
}

/** Count of addresses ever drafted (still-drafted or later bounced) — the
 *  global rotation index base for subject/opener variants. */
export function draftedEverCount(state: BlastState): number {
  return state.records.filter((r) => r.status !== "skipped_invalid").length;
}

export function maxBatch(state: BlastState): number {
  return state.records.reduce((m, r) => Math.max(m, r.batch), 0);
}
