// Downloads data/job_hunter.db from Google Drive, replacing the local copy; verifies integrity in a temp file before swapping it in, and refuses when the local copy is newer unless --force.
import "dotenv/config";
import { pullDb, checkState, syncSkipReason } from "../src/db/sync.js";
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

  // Each profile is a separate Google account with its own Drive - the wrong profile would fetch a different database.
  const skip = syncSkipReason(profileId);
  if (skip !== null && !force) {
    logger.error({ profileId }, `refusing to pull: ${skip}`);
    process.exit(1);
  }

  const before = await checkState(profileId);
  if (before.verdict === "local-newer" && !force) {
    logger.error(
      { remoteModified: before.remote?.modifiedTime },
      "refusing to pull: your local DB is NEWER than the Drive copy. " +
        "A previous run here never pushed — pulling would throw that away. " +
        "Run `npm run db:push` first, or re-run with --force to discard local changes.",
    );
    process.exit(1);
  }

  const result = await pullDb(profileId, { force });
  if (result.action === "skipped") {
    logger.info("nothing to pull — no backup exists in Drive yet");
    process.exit(0);
  }
  logger.info({ megabytes: (result.bytes / 1048576).toFixed(1) }, "db:pull complete");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "db:pull failed");
  process.exit(1);
});
