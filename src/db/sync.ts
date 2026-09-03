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

/** A push below this fraction of the remote's size is refused as data loss rather than progress; --force overrides a deliberate shrink. */
const SHRINK_REFUSE_RATIO = 0.5;

export interface SyncDeps extends DriveDeps {
  /** Overrides config.storage.dbPath; tests set it so a sync never touches the real database. */
  dbPath?: string;
  /** Skip the safety refusals in pushDb. Only ever set from an explicit --force. */
  force?: boolean;
}

function dbPathOf(deps: SyncDeps): string {
  return deps.dbPath ?? config.storage.dbPath;
}

/** Pure decision: given the two modified times, who is ahead? Kept separate from I/O so it's unit-testable. */
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
  /** Rows in `postings`; null if no file/table, 0 if the file exists but was never used (db.ts creates it on import). */
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
    // No postings table yet, or an unreadable file - either way, not worth pushing over the backup.
    logger.debug({ err: String(err).slice(0, 120) }, "db sync: could not count local postings");
  }
  return { mtimeMs: stat.mtimeMs, bytes: stat.size, postings };
}

/** compareState plus the one thing timestamps can't express: a local file with no postings is a fresh machine, not one that's ahead. */
export function decideBeforeRun(local: LocalDbState, remoteMtimeMs: number | null): SyncVerdict {
  if (remoteMtimeMs === null) return "no-remote";
  if (local.postings === null || local.postings === 0) return "no-local";
  return compareState(local.mtimeMs, remoteMtimeMs);
}

/** May this local file replace the remote one? Throws (not a boolean) so no caller can forget to check. */
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

/** Stamp the local file with the remote's mtime after a transfer, or the upload-duration gap would exceed skew tolerance and every run would re-download what it just uploaded. */
function alignMtimeToRemote(dbPath: string, remote: DriveFileMeta): void {
  const ms = Date.parse(remote.modifiedTime);
  if (!Number.isFinite(ms)) return;
  const seconds = ms / 1000;
  utimesSync(dbPath, seconds, seconds);
}

/** `PRAGMA wal_checkpoint` returns busy (gave up?), log (WAL frame count), checkpointed (frames moved to the main file). */
const CheckpointSchema = z.object({
  busy: z.number(),
  log: z.number(),
  checkpointed: z.number(),
});

/** How long to keep waiting for another connection to let go. */
const CHECKPOINT_TIMEOUT_MS = 30_000;
const CHECKPOINT_RETRY_DELAY_MS = 1_000;
/** Deliberately short: node:sqlite is synchronous, so a longer value here would freeze the process; waiting happens between attempts instead. */
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

/** Folds the WAL into the main file before upload; busy=1 during TRUNCATE means another connection holds the DB (retried for 30s), not a failure - only truly uncopied frames fail the push. */
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

/** Downloads to a sibling temp file, integrity-checks it, then swaps - a half-finished or corrupt download can never clobber a working database. */
export async function pullDb(profileId: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const dbPath = dbPathOf(deps);
  // Swap is only safe while nothing holds the file open: Windows rejects the rename with EPERM, Linux silently keeps reading the replaced file.
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

/** Profiles are separate Google accounts; an unpinned second profile would fork its own backup and pull it over the shared local DB, so DB_SYNC_PROFILE pins the owning profile and others skip sync. */
export function syncSkipReason(profileId: string): string | null {
  const pinned = config.google.driveSyncProfile;
  if (pinned === "" || pinned === profileId) return null;
  return `DB sync is pinned to profile '${pinned}' via DB_SYNC_PROFILE; '${profileId}' uses a different Google account, so its Drive holds a different backup.`;
}

/** A failure while deciding only logs (sync loss shouldn't abort a scrape), but a failure while pulling propagates - a known-stale local DB must stop the run. */
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
