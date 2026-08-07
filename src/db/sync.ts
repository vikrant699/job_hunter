// src/db/sync.ts - keeps data/job_hunter.db in step across machines via Drive.
//
// Why this exists: the bot runs by hand on more than one machine. Starting a run
// against a stale DB is not a mild problem - postingExists() would return false
// for postings the other machine already processed, so the gate re-scores them
// and outreach drafts a SECOND email to recruiters who were already contacted.
// The staleness comparison below is the guard against that.
//
// Two rules this file is built around, both learned the hard way:
//  1. A pull may only run while NOTHING holds the DB open (see openState.ts).
//  2. mtime alone cannot tell a fresh machine from an up-to-date one, because
//     db.ts CREATES the file on import - so a brand-new empty DB looks "newer"
//     than the real backup. Row counts settle that; see decideBeforeRun.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  existsSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util/sleep.js";
import { findDbFile, uploadDbFile, downloadDbFile } from "../google/drive.js";
import type { DriveDeps, DriveFileMeta } from "../google/drive.js";
import { isDbOpen } from "./openState.js";

/** Which side is ahead. Drives both the CLI scripts and the pre-flight guard. */
export type SyncVerdict = "in-sync" | "remote-newer" | "local-newer" | "no-remote" | "no-local";

/** Clock skew between two machines shouldn't read as a real difference. */
const SKEW_TOLERANCE_MS = 5_000;

/**
 * A push whose local file is below this fraction of the remote is refused: that
 * shape means "this machine has less data than the backup", which is data loss
 * rather than progress. A deliberate shrink (the jd_text drop shed 92% of the
 * file) is exactly what --force is for.
 */
const SHRINK_REFUSE_RATIO = 0.5;

export interface SyncDeps extends DriveDeps {
  /** Overrides config.storage.dbPath. Tests set it so a sync never touches the
   *  real database; production always uses the config value. */
  dbPath?: string;
  /** Skip the safety refusals in pushDb. Only ever set from an explicit --force. */
  force?: boolean;
}

function dbPathOf(deps: SyncDeps): string {
  return deps.dbPath ?? config.storage.dbPath;
}

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

export interface LocalDbState {
  mtimeMs: number | null;
  bytes: number;
  /**
   * Rows in `postings`. null when there is no file or no such table; 0 when the
   * file exists but has never been used - which db.ts produces on every fresh
   * machine, since importing it creates the database.
   */
  postings: number | null;
}

const CountSchema = z.object({ n: z.number() });

/** Read everything about the local DB the decisions below need. Never throws. */
export function readLocalState(dbPath: string): LocalDbState {
  if (!existsSync(dbPath)) return { mtimeMs: null, bytes: 0, postings: null };
  const stat = statSync(dbPath);
  let postings: number | null = null;
  try {
    const handle = new DatabaseSync(dbPath);
    try {
      postings = CountSchema.parse(handle.prepare("SELECT COUNT(*) AS n FROM postings").get()).n;
    } finally {
      handle.close();
    }
  } catch (err) {
    // No postings table yet, or an unreadable file. Either way it is not a
    // database worth pushing over the backup, which is what the caller asks.
    logger.debug({ err: String(err).slice(0, 120) }, "db sync: could not count local postings");
  }
  return { mtimeMs: stat.mtimeMs, bytes: stat.size, postings };
}

/**
 * Pure: what should happen before a run. This is compareState plus the one thing
 * timestamps cannot express - a local file that exists but holds no postings is a
 * fresh machine, not a machine that is ahead. Without this the automatic path
 * warned "local is newer", ran against an empty DB, and pushed it over the good
 * backup.
 */
export function decideBeforeRun(local: LocalDbState, remoteMtimeMs: number | null): SyncVerdict {
  if (remoteMtimeMs === null) return "no-remote";
  if (local.postings === null || local.postings === 0) return "no-local";
  return compareState(local.mtimeMs, remoteMtimeMs);
}

/**
 * Pure: may this local file replace the remote one? Refuses the two shapes that
 * mean loss rather than progress. Throws (rather than returning a boolean) so no
 * caller can forget to check the answer.
 */
export function assertPushSafe(
  local: LocalDbState,
  remoteBytes: number | null,
  force: boolean,
): void {
  if (force) return;
  if (local.postings === null || local.postings === 0) {
    throw new Error(
      "refusing to push: the local DB holds no postings. That is a freshly created " +
        "database, and pushing it would overwrite the real backup. Run `npm run db:pull` " +
        "first, or pass --force if you really mean to replace the backup with this.",
    );
  }
  if (remoteBytes !== null && local.bytes < remoteBytes * SHRINK_REFUSE_RATIO) {
    const mb = (n: number): string => (n / 1048576).toFixed(1);
    throw new Error(
      `refusing to push: the local DB (${mb(local.bytes)} MB) is less than half the size of ` +
        `the Drive copy (${mb(remoteBytes)} MB), which looks like data loss rather than progress. ` +
        `If the shrink is deliberate (a migration that drops a column, say), re-run with --force.`,
    );
  }
}

function remoteBytesOf(remote: DriveFileMeta | null): number | null {
  if (remote?.size === undefined) return null;
  const n = Number(remote.size);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stamp the local file with the remote's modified time after a successful
 * transfer, so the next comparison reads "in-sync".
 *
 * Without this the two clocks never line up: a push records the remote time at
 * upload COMPLETION while the local file was last written before it started, and
 * for a ~50 MB upload that gap exceeds the skew tolerance - so every run would
 * see "remote-newer" and re-download the file it had just uploaded.
 */
function alignMtimeToRemote(dbPath: string, remote: DriveFileMeta): void {
  const ms = Date.parse(remote.modifiedTime);
  if (!Number.isFinite(ms)) return;
  const seconds = ms / 1000;
  utimesSync(dbPath, seconds, seconds);
}

/**
 * `PRAGMA wal_checkpoint` returns three values: whether it gave up (busy), how many
 * frames the WAL held (log), and how many it managed to move into the main file
 * (checkpointed).
 */
const CheckpointSchema = z.object({
  busy: z.number(),
  log: z.number(),
  checkpointed: z.number(),
});

/** How long to keep waiting for another connection to let go. */
const CHECKPOINT_TIMEOUT_MS = 30_000;
const CHECKPOINT_RETRY_DELAY_MS = 1_000;
/**
 * Per-attempt lock wait. Deliberately short: SQLite honours busy_timeout inside the
 * checkpoint, and node:sqlite is synchronous, so a 30s value here would freeze the
 * whole process for 30s. The waiting is done between attempts instead.
 */
const CHECKPOINT_BUSY_TIMEOUT_MS = 1_000;

export interface CheckpointOpts {
  timeoutMs?: number;
  retryDelayMs?: number;
  busyTimeoutMs?: number;
}

/** One attempt. Returns what SQLite reported, or null if the result was unreadable. */
function attemptCheckpoint(dbPath: string, busyTimeoutMs: number): z.infer<typeof CheckpointSchema> | null {
  const handle = new DatabaseSync(dbPath);
  try {
    handle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    const parsed = CheckpointSchema.safeParse(handle.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
    return parsed.success ? parsed.data : null;
  } finally {
    handle.close();
  }
}

/**
 * Fold the WAL back into the main file so the .db on disk is complete on its own.
 * Without this the newest commits can still be sitting in job_hunter.db-wal and
 * the uploaded file would be silently behind.
 *
 * A TRUNCATE checkpoint cannot finish while another connection holds the database,
 * and SQLite reports that as busy=1 rather than failing. Busy is a normal, passing
 * condition though - a stray `npm run health`, an editor with the file open - so it
 * is RETRIED for 30s rather than treated as a failed push.
 *
 * What matters after that window is not busy itself but whether the data made it
 * across, which `log` vs `checkpointed` answers:
 *  - all frames copied: the .db is complete and only the WAL file survives
 *    untruncated. Harmless - warn and let the push proceed.
 *  - frames left over (a reader pinning an OLD snapshot blocks copying): the file on
 *    disk is genuinely missing committed rows, and uploading it would lose them. That
 *    is the only case worth failing.
 */
export async function checkpointWal(dbPath: string, opts: CheckpointOpts = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? CHECKPOINT_RETRY_DELAY_MS;
  const busyTimeoutMs = opts.busyTimeoutMs ?? CHECKPOINT_BUSY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;
  for (;;) {
    attempts++;
    const result = attemptCheckpoint(dbPath, busyTimeoutMs);
    // Unreadable result: no evidence of a problem, so do not invent one.
    if (result === null || result.busy === 0) return;

    if (Date.now() >= deadline) {
      const pending = result.log - result.checkpointed;
      if (pending <= 0) {
        logger.warn(
          { attempts, timeoutMs, ...result },
          "db sync: WAL could not be truncated (another connection is reading), but every " +
            "frame reached the database — the upload is complete, continuing",
        );
        return;
      }
      throw new Error(
        `WAL checkpoint gave up after ${attempts} attempts over ${timeoutMs}ms with ${pending} ` +
          `frame(s) still in the WAL, so ${dbPath} on disk is missing committed rows and must ` +
          `not be uploaded. Close whatever else is using the database, then retry.`,
      );
    }
    logger.warn(
      { attempts, ...result },
      "db sync: WAL checkpoint busy — another connection holds the database, retrying",
    );
    await sleep(retryDelayMs);
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
export async function pushDb(profileId: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const dbPath = dbPathOf(deps);
  if (!existsSync(dbPath)) throw new Error(`no local database at ${dbPath}`);

  const existing = await findDbFile(profileId, deps);
  assertPushSafe(readLocalState(dbPath), remoteBytesOf(existing), deps.force ?? false);

  await checkpointWal(dbPath);
  const bytes = readFileSync(dbPath);
  const remote = await uploadDbFile(profileId, bytes, existing?.id ?? null, deps);
  alignMtimeToRemote(dbPath, remote);

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
export async function pullDb(profileId: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const dbPath = dbPathOf(deps);
  // The whole swap is only safe while nothing holds the file open. Checked here
  // rather than trusted, because the two platforms fail differently and only one
  // of them fails loudly: Windows rejects the rename with EPERM, while Linux
  // accepts it and leaves the open handle reading the file we just replaced.
  if (isDbOpen()) {
    throw new Error(
      "refusing to pull: the SQLite connection in db/db.ts is already open, so replacing " +
        "the file would either fail (Windows) or leave this process reading the old one " +
        "(Linux). Sync must run before anything imports src/db/db.ts.",
    );
  }

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
  alignMtimeToRemote(dbPath, remote);

  logger.info({ bytes: bytes.byteLength, fileId: remote.id }, "db sync: pulled from Drive");
  return { verdict: "remote-newer", action: "downloaded", bytes: bytes.byteLength, remote };
}

/** Compare the local DB against the Drive copy without transferring the file. */
export async function checkState(
  profileId: string,
  deps: SyncDeps = {},
): Promise<{ verdict: SyncVerdict; remote: DriveFileMeta | null; local: LocalDbState }> {
  const remote = await findDbFile(profileId, deps);
  const remoteMs = remote === null ? null : Date.parse(remote.modifiedTime);
  const local = readLocalState(dbPathOf(deps));
  return { verdict: decideBeforeRun(local, remoteMs), remote, local };
}

/**
 * Why a run might legitimately not sync at all: the backup lives in ONE Google
 * account's Drive, and profiles are separate accounts (drive.file only ever sees
 * files the app created under the signed-in account). Running an unpinned second
 * profile would therefore create a second, independent backup and pull it over the
 * shared local DB. DB_SYNC_PROFILE names the profile that owns the backup; other
 * profiles skip sync instead of forking it.
 */
export function syncSkipReason(profileId: string): string | null {
  const pinned = config.google.driveSyncProfile;
  if (pinned === "" || pinned === profileId) return null;
  return `DB sync is pinned to profile '${pinned}' via DB_SYNC_PROFILE; '${profileId}' uses a different Google account, so its Drive holds a different backup.`;
}

/**
 * Pre-flight for `npm run once`: pull when Drive is ahead (the "sat down at the
 * other machine" case) or when this machine has no real database yet, and shout
 * when the local copy is ahead, because that means an earlier run never pushed.
 *
 * A Drive failure while *deciding* is survivable and only logs - losing sync must
 * not abort a scrape that would otherwise succeed. A failure while *pulling* is
 * not: it means we know the local DB is stale, and running stale is what produces
 * duplicate recruiter emails. So that one propagates and stops the run.
 *
 * MUST be called before anything imports db/db.ts; pullDb enforces it.
 */
export async function syncBeforeRun(profileId: string, deps: SyncDeps = {}): Promise<void> {
  const skip = syncSkipReason(profileId);
  if (skip !== null) {
    logger.info({ profileId }, `db sync: skipped — ${skip}`);
    return;
  }

  let state: { verdict: SyncVerdict; remote: DriveFileMeta | null };
  try {
    state = await checkState(profileId, deps);
  } catch (err) {
    logger.warn(
      { err: String(err).slice(0, 160) },
      "db sync: state check failed — continuing with the local DB",
    );
    return;
  }

  switch (state.verdict) {
    case "remote-newer":
    case "no-local":
      logger.info(
        { remoteModified: state.remote?.modifiedTime, verdict: state.verdict },
        "db sync: Drive holds the newer database — pulling before the run",
      );
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
export async function syncAfterRun(profileId: string, deps: SyncDeps = {}): Promise<void> {
  const skip = syncSkipReason(profileId);
  if (skip !== null) {
    logger.info({ profileId }, `db sync: post-run push skipped — ${skip}`);
    return;
  }
  try {
    await pushDb(profileId, deps);
  } catch (err) {
    logger.error(
      { err: String(err).slice(0, 200) },
      "db sync: post-run push FAILED — run `npm run db:push` before switching machines",
    );
  }
}
