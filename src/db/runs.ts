import type { SQLInputValue } from "node:sqlite";
import { db } from "./db.js";

const insertRunStmt = db.prepare(`
  INSERT INTO runs (kind, profile_id, started_at) VALUES (:kind, :profileId, :startedAt)
`);

export function startRun(kind: "production", profileId: string): number {
  const result = insertRunStmt.run({ kind, profileId, startedAt: new Date().toISOString() });
  return Number(result.lastInsertRowid);
}

const finishRunStmt = db.prepare(`
  UPDATE runs SET
    ended_at          = :endedAt,
    companies_scanned = :companiesScanned,
    postings_seen     = :postingsSeen,
    postings_new      = :postingsNew,
    postings_notified = :postingsNotified,
    candidates_added  = :candidatesAdded,
    error             = :error
  WHERE id = :id
`);

export interface FinishRunInput {
  [key: string]: SQLInputValue;
  id: number;
  endedAt: string;
  companiesScanned: number;
  postingsSeen: number;
  postingsNew: number;
  postingsNotified: number;
  candidatesAdded: number | null;
  error: string | null;
}

export function finishRun(input: FinishRunInput): void {
  finishRunStmt.run(input);
}
