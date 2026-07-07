/**
 * Standalone verify pass for one profile's mailbox, outside the daily tick.
 *
 *   npm run verify-outreach -- --profile vikrant
 *
 * Runs runVerify() then projectToSheet() for that profile and prints the
 * result summary. Useful for checking bounces/replies without waiting for
 * the next `npm run once`.
 *
 * NOTE: `--profile` here does DOUBLE duty, same as everywhere else in this
 * repo (see src/profile.ts's selectedProfileName + src/outreach/run.ts's
 * identity guard): it selects which config/profiles/<name>/profile.ts loads
 * (imported transitively below), AND which Gmail/Sheets token file
 * (data/google-token-<name>.json) runVerify's Google calls use. There is no
 * separate flag for the two — one argv value drives both.
 */
import "dotenv/config";
import { runVerify } from "../src/outreach/verify.js";
import { projectToSheet } from "../src/outreach/sheet-sync.js";
import { profile } from "../src/profile.js";
import { logger } from "../src/logger.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const profileId = argValue("--profile") ?? "default";

  // Same identity guard runOutreach uses: catch a profileId/loaded-profile
  // mismatch before touching Gmail, rather than checking a mailbox that
  // doesn't belong to the profile whose data we're about to write.
  const loadedProfileId = profile.id ?? "default";
  if (profileId !== loadedProfileId) {
    throw new Error(
      `verify-outreach: profileId "${profileId}" does not match the loaded profile "${loadedProfileId}" ` +
        `— run with --profile ${profileId} so identity and Gmail token agree`,
    );
  }

  const result = await runVerify({ profileId, runId: null });
  await projectToSheet(profileId);

  console.log(`\nverify-outreach (${profileId}):`);
  console.log(`  checked drafts : ${result.checkedDrafts}`);
  console.log(`  -> sent        : ${result.sent}`);
  console.log(`  -> discarded   : ${result.discarded}`);
  console.log(`  bounced        : ${result.bounced}`);
  console.log(`  verified       : ${result.verified}`);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "verify-outreach failed");
  process.exitCode = 1;
});
