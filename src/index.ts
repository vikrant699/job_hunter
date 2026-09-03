import "dotenv/config";
import { logger } from "./logger.js";
import { assertLlmAvailable } from "./llm/client.js";
import { LlmUnavailableError } from "./llm/errors.js";
import { assertGoogleTokenValid, GoogleAuthExpiredError } from "./google/auth.js";
import { syncBeforeRun, syncAfterRun } from "./db/sync.js";
import { startConnectivityMonitor } from "./util/connectivity.js";
import { profile } from "./profile.js";
import { runInstahyreAutoApply } from "./instahyre/autoApply.js";
import type { InstahyreResult } from "./instahyre/autoApply.js";

// No static import here may reach src/db/db.ts (it opens the SQLite file on load, which syncBeforeRun replaces) - the run body lives in ./runOnce.ts, reached via dynamic import after the sync; pinned by indexImportGraph.test.ts.

function printUsage(): void {
  console.log(`Usage: npm run <command> [-- --profile <name>]

  once       Run a single production tick for one profile: fetch → filter → notify

  --profile <name>   Use config/profiles/<name>/ (profile.ts + resume.pdf).
                     Omit for the default (config/profile.ts).
`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--help") || args.has("-h")) {
    printUsage();
    process.exit(0);
  }

  const once = args.has("--once");

  if (!once) {
    printUsage();
    process.exit(1);
  }

  const profileId = profile.id ?? "default";

  // Start before pre-flights so a run launched mid-outage waits (unbounded) instead of exiting; every outbound call resumes where it left off.
  const stopConnectivity = startConnectivityMonitor();

  // Fail-fast pre-flights before the ~30s registry sync: bad LLM backend or expired Google token must surface in seconds, not after a multi-hour tick.
  await assertLlmAvailable();
  await assertGoogleTokenValid(profileId);

  // Phase 0: Instahyre auto-apply (headed browser; skips when no creds or no jobs; never throws).
  const instahyre: InstahyreResult = await runInstahyreAutoApply(profileId);

  // Pull a newer DB from Drive before anything opens it, or a stale DB re-scores postings the other machine already handled.
  await syncBeforeRun(profileId);

  // Only now is it safe to load the DB-backed half of the app.
  const { runOnceAfterSync, releaseDbForSync } = await import("./runOnce.js");
  await runOnceAfterSync(profileId, instahyre);

  // Best-effort: a Drive push failure here must not fail an already-completed run.
  releaseDbForSync();
  await syncAfterRun(profileId);
  stopConnectivity();
  process.exit(0);
}

main().catch((err) => {
  // Pre-flight guards are expected, actionable stops - log just the message, no stack noise.
  if (err instanceof LlmUnavailableError || err instanceof GoogleAuthExpiredError) {
    logger.error(`aborting — ${err.message}`);
  } else {
    logger.error({ err: String(err) }, "fatal");
  }
  process.exit(1);
});
