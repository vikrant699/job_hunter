/**
 * TEMPORARY weekly blast for the Raw Data tab (design spec:
 * docs/superpowers/specs/2026-07-09-divya-blast-design.md).
 *
 *   npm run blast -- --profile divya                # sweep + draft next 100
 *   npm run blast -- --profile divya --limit 50
 *   npm run blast -- --profile divya --verify-only  # bounce check only
 *   npm run blast -- --profile divya --force        # override safety guards
 *
 * Drafts only, NEVER sends. Divya schedule-sends from the Gmail UI
 * (11:00-12:30 IST weekdays, ~20/day). Deliberately does not import
 * src/profile.ts: the blast needs only the Gmail/Sheets token identity, not
 * the job_hunter profile config.
 */
import "dotenv/config";
import { assertGoogleTokenValid } from "../src/google/auth.js";
import { runBlast } from "../src/blast/run.js";
import { logger } from "../src/logger.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function main(): Promise<void> {
  const profileId = argValue("--profile");
  if (profileId === null) {
    throw new Error("blast: --profile <name> is required (e.g. --profile divya)");
  }
  const limitRaw = argValue("--limit");
  const limit = limitRaw === null ? 100 : Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`blast: --limit must be an integer between 1 and 200 (got ${limitRaw ?? "nothing"})`);
  }
  const verifyOnly = process.argv.includes("--verify-only");
  const force = process.argv.includes("--force");

  await assertGoogleTokenValid(profileId);
  const summary = await runBlast({ profileId, limit, verifyOnly, force });

  console.log(`\nblast (${profileId})${verifyOnly ? " [verify-only]" : ""}:`);
  console.log(`  bounce sweep    : ${summary.sweepChecked} checked, ${summary.newlyBounced} newly bounced`);
  console.log(`  last batch rate : ${summary.lastBatchBounceRatePct === null ? "n/a" : `${summary.lastBatchBounceRatePct.toFixed(1)}%`}`);
  if (!verifyOnly) {
    console.log(`  batch #${String(summary.batch)}  : ${summary.drafted} drafts created, ${summary.skippedInvalid} skipped (no MX)`);
    console.log(`  remaining pool  : ~${summary.remaining} addresses (~${Math.ceil(summary.remaining / Math.max(limit, 1))} more weekly runs)`);
    console.log(`\nNext: schedule-send the drafts from Gmail, 11:00-12:30 IST weekdays (~20/day).`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
main().catch((err: unknown) => {
  logger.error({ err: String(err) }, "blast failed");
  process.exitCode = 1;
});
