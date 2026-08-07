// src/db/sync.ts - keeps data/job_hunter.db in step across machines via Drive.
//
// Why this exists: the bot runs by hand on more than one machine. Starting a run
// against a stale DB is not a mild problem - postingExists() would return false
// for postings the other machine already processed, so the gate re-scores them
// and outreach drafts a SECOND email to recruiters who were already contacted.
// The staleness comparison below is the guard against that.
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { findDbFile, uploadDbFile, downloadDbFile } from "../google/drive.js";
import type { DriveDeps, DriveFileMeta } from "../google/drive.js";

/** Which side is ahead. Drives both the CLI scripts and the pre-flight guard. */
export type SyncVerdict = "in-sync" | "remote-newer" | "local-newer" | "no-remote" | "no-local";

/** Clock skew between two machines shouldn't read as a real difference. */
const SKEW_TOLERANCE_MS = 5_000;

/**
 * Pure decision: given the two modified times, who is ahead? Kept separate from
 * all I/O so the interesting logic is unit-testable.
 */
export function compareState(
  localMtimeMs: number | null,
  remoteMtimeMs: number | null,
): SyncVerdict {
  if (remoteMtimeMs === null) return localMtimeMs === null ? "no-local" : "no-remote";
  if (localMtimeMs === null) return "no-local";
  const delta = localMtimeMs - remoteMtimeMs;
  if (Math.abs(delta) <= SKEW_TOLERANCE_MS) return "in-sync";
  return delta > 0 ? "local-newer" : "remote-newer";
}

function localMtimeMs(path: string): number | null {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

/**
 * Fold the WAL back into the main file so the .db on disk is complete on its own.
 * Without this the newest commits can still be sitting in job_hunter.db-wal and
 * the uploaded file would be silently behind.
 */
export function checkpointWal(dbPath: string): void {
  const handle = new DatabaseSync(dbPath);
  try {
    handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    handle.close();
  }
}

/** Reject a download that isn't a healthy SQLite database before it replaces anything. */
function assertHealthyDb(path: string): void {
  const handle = new DatabaseSync(path);
  try {
    const RowSchema = z.object({ integrity_check: z.string() });
    const row = RowSchema.parse(handle.prepare("PRAGMA integrity_check").get());
    if (row.integrity_check !== "ok") {
      throw new Error(`downloaded DB failed integrity_check: ${row.integrity_check}`);
    }
  } finally {
    handle.close();
  }
}

export interface SyncResult {
  verdict: SyncVerdict;
  action: "uploaded" | "downloaded" | "skipped";
  bytes: number;
  remote: DriveFileMeta | null;
}

/** Push the local DB to Drive, creating the remote file on first use. */
export async function pushDb(profileId: string, deps: DriveDeps = {}): Promise<SyncResult> {
  const dbPath = config.storage.dbPath;
  if (!existsSync(dbPath)) throw new Error(`no local database at ${dbPath}`);

  checkpointWal(dbPath);
  const bytes = readFileSync(dbPath);
  const existing = await findDbFile(profileId, deps);
  const remote = await uploadDbFile(profileId, bytes, existing?.id ?? null, deps);

  logger.info(
    { bytes: bytes.byteLength, fileId: remote.id, created: existing === null },
    "db sync: pushed to Drive",
  );
  return { verdict: "local-newer", action: "uploaded", bytes: bytes.byteLength, remote };
}

/**
 * Pull the remote DB over the local one. Downloads to a sibling temp file,
 * integrity-checks it, and only then swaps - so a half-finished or corrupt
 * download can never clobber a working database.
 */
export async function pullDb(profileId: string, deps: DriveDeps = {}): Promise<SyncResult> {
  const dbPath = config.storage.dbPath;
  const remote = await findDbFile(profileId, deps);
  if (remote === null) {
    logger.info("db sync: no remote backup yet — nothing to pull");
    return { verdict: "no-remote", action: "skipped", bytes: 0, remote: null };
  }

  const bytes = await downloadDbFile(profileId, remote.id, deps);
  const tmp = `${dbPath}.pull-tmp`;
  writeFileSync(tmp, bytes);
  try {
    assertHealthyDb(tmp);
  } catch (err) {
    unlinkSync(tmp);
    throw err;
  }

  // Stale -wal/-shm describe the OLD file; leaving them would corrupt the new one.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
  }
  renameSync(tmp, dbPath);

  logger.info({ bytes: bytes.byteLength, fileId: remote.id }, "db sync: pulled from Drive");
  return { verdict: "remote-newer", action: "downloaded", bytes: bytes.byteLength, remote };
}

/** Compare local mtime against the Drive copy without transferring the file. */
export async function checkState(
  profileId: string,
  deps: DriveDeps = {},
): Promise<{ verdict: SyncVerdict; remote: DriveFileMeta | null }> {
  const remote = await findDbFile(profileId, deps);
  const remoteMs = remote === null ? null : Date.parse(remote.modifiedTime);
  return { verdict: compareState(localMtimeMs(config.storage.dbPath), remoteMs), remote };
}

/**
 * Pre-flight for `npm run once`. Silently pulls when the remote is ahead (the
 * "sat down at the other machine" case), and shouts when the local copy is ahead
 * because that means an earlier run never pushed. Never throws on a Drive
 * failure: losing sync must not abort a scrape that would otherwise succeed -
 * but it does refuse to continue on remote-newer, since running stale is exactly
 * what produces duplicate recruiter emails.
 */
export async function syncBeforeRun(profileId: string, deps: DriveDeps = {}): Promise<void> {
  let state: { verdict: SyncVerdict; remote: DriveFileMeta | null };
  try {
    state = await checkState(profileId, deps);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 160) }, "db sync: state check failed — continuing with the local DB");
    return;
  }

  switch (state.verdict) {
    case "remote-newer":
    case "no-local":
      logger.info({ remoteModified: state.remote?.modifiedTime }, "db sync: remote is newer — pulling before the run");
      await pullDb(profileId, deps);
      return;
    case "local-newer":
      logger.warn(
        { remoteModified: state.remote?.modifiedTime },
        "db sync: local DB is AHEAD of Drive — a previous run never pushed. Continuing; run `npm run db:push` after this run.",
      );
      return;
    case "no-remote":
      logger.info("db sync: no Drive backup yet — it will be created after this run");
      return;
    case "in-sync":
      logger.info("db sync: local DB matches Drive");
      return;
  }
}

/** Post-run push. Best-effort: a Drive outage must not fail a completed run. */
export async function syncAfterRun(profileId: string, deps: DriveDeps = {}): Promise<void> {
  try {
    await pushDb(profileId, deps);
  } catch (err) {
    logger.error(
      { err: String(err).slice(0, 200) },
      "db sync: post-run push FAILED — run `npm run db:push` before switching machines",
    );
  }
}
