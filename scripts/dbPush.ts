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
import { pushDb, checkState } from "../src/db/sync.js";
import { assertGoogleTokenValid } from "../src/google/auth.js";
import { logger } from "../src/logger.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const profileId = argValue("--profile") ?? "default";
  await assertGoogleTokenValid(profileId);

  const before = await checkState(profileId);
  if (before.verdict === "remote-newer" && !process.argv.includes("--force")) {
    logger.error(
      { remoteModified: before.remote?.modifiedTime },
      "refusing to push: the Drive copy is NEWER than your local DB. " +
        "Another machine pushed after you last pulled — pushing now would overwrite that work. " +
        "Run `npm run db:pull` first, or re-run with --force if you are certain.",
    );
    process.exit(1);
  }

  const result = await pushDb(profileId);
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
