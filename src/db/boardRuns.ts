import type { SQLInputValue } from "node:sqlite";
import type { Provider } from "../schemas.js";
import { db } from "./db.js";

const BOARD_RUN_STATUSES = ["ok", "error"] as const;
export type BoardRunStatus = (typeof BOARD_RUN_STATUSES)[number];

// Per-board fetch history is a health signal, not an audit log — pruned to the newest N runs on every insert.
const BOARD_RUNS_KEEP = 60;

const insertBoardRunStmt = db.prepare(`
  INSERT INTO board_runs (provider, company_slug, profile_id, run_at, status, added, removed, unchanged, error)
  VALUES (:provider, :companySlug, :profileId, :runAt, :status, :added, :removed, :unchanged, :error)
`);

const pruneBoardRunsStmt = db.prepare(`
  DELETE FROM board_runs
  WHERE provider = :provider AND company_slug = :companySlug
    AND rowid NOT IN (
      SELECT rowid FROM board_runs
      WHERE provider = :provider AND company_slug = :companySlug
      ORDER BY run_at DESC
      LIMIT :keep
    )
`);

export interface InsertBoardRunInput {
  [key: string]: SQLInputValue;
  provider: Provider;
  companySlug: string;
  profileId: string;
  runAt: string;
  status: BoardRunStatus;
  added: number;
  removed: number;
  unchanged: number;
  error: string | null;
}

/** Records one company fetch's lifecycle delta (added/removed/unchanged, or an error) and prunes that board's history to the newest 60 rows. */
export function insertBoardRun(row: InsertBoardRunInput): void {
  insertBoardRunStmt.run(row);
  pruneBoardRunsStmt.run({ provider: row.provider, companySlug: row.companySlug, keep: BOARD_RUNS_KEEP });
}
