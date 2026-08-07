/**
 * Upload data/job_hunter.db to Google Drive so another machine can pick it up.
 *
 *   npm run db:push -- --profile vikrant
 *
 * Checkpoints the WAL first so the uploaded file is complete on its own, then
 * creates or replaces the Drive copy. Run this after a sweep if you are about to
 * switch machines - `npm run once` already pushes automatically when it finishes.
 *
 * `--profile` selects the Google token file (data/google-token-<name>.json),
 * same as everywhere else in this repo. The Drive backup itself is shared, not
 * per-profile: it is one database.
 */
import "dotenv/config";
import { pushDb, checkState, syncSkipReason } from "../src/db/sync.js";
import { assertGoogleTokenValid } from "../src/google/auth.js";
import { logger } from "../src/logger.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const profileId = argValue("--profile") ?? "default";
  const force = process.argv.includes("--force");
  await assertGoogleTokenValid(profileId);

  // Profiles are separate Google accounts, so pushing from the wrong one does not
  // overwrite the backup - it creates a SECOND one in that account's Drive, which
  // then starts competing with the real one.
  const skip = syncSkipReason(profileId);
  if (skip !== null && !force) {
    logger.error({ profileId }, `refusing to push: ${skip} Pass --force only if you intend a separate backup in that account's Drive.`);
    process.exit(1);
  }

  const before = await checkState(profileId);
  if (before.verdict === "remote-newer" && !force) {
    logger.error(
      { remoteModified: before.remote?.modifiedTime },
      "refusing to push: the Drive copy is NEWER than your local DB. " +
        "Another machine pushed after you last pulled — pushing now would overwrite that work. " +
        "Run `npm run db:pull` first, or re-run with --force if you are certain.",
    );
    process.exit(1);
  }

  // force also lifts pushDb's own refusals (empty DB / a file less than half the
  // size of the backup) - both are shapes that usually mean loss, but a migration
  // that drops a column is a legitimate reason to shrink.
  const result = await pushDb(profileId, { force });
  logger.info(
    { megabytes: (result.bytes / 1048576).toFixed(1), fileId: result.remote?.id },
    "db:push complete",
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "db:push failed");
  process.exit(1);
});
