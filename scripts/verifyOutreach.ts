/**
 * Standalone verify pass for one profile's mailbox, outside the daily tick.
 *   npm run verify-outreach -- --profile vikrant
 * Runs runVerify() then projectToSheet() and prints the summary. `--profile` does double duty:
 * it selects both the loaded config/profiles/<name>/profile.ts AND the Gmail/Sheets token file.
 */
import "dotenv/config";
import { runVerify } from "../src/outreach/verify.js";
import { projectToSheet } from "../src/outreach/sheetSync.js";
import { profile } from "../src/profile.js";
import { logger } from "../src/logger.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const profileId = argValue("--profile") ?? "default";

  // Same identity guard runOutreach uses: catch a mismatch before touching Gmail.
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
