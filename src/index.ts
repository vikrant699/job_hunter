import "dotenv/config";
import { logger } from "./logger.js";
import { assertLlmAvailable } from "./llm/client.js";
import { LlmUnavailableError } from "./llm/errors.js";
import { assertGoogleTokenValid, GoogleAuthExpiredError } from "./google/auth.js";
import { syncBeforeRun, syncAfterRun } from "./db/sync.js";
import { startConnectivityMonitor } from "./util/connectivity.js";
import { profile } from "./profile.js";

// No static import here may reach src/db/db.ts (it opens the SQLite file on load, which syncBeforeRun replaces); pinned by indexImportGraph.test.ts.

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

  // Start before pre-flights so a run launched mid-outage waits instead of exiting.
  const stopConnectivity = startConnectivityMonitor();

  // Fail fast before the ~30s registry sync.
  await assertLlmAvailable();
  await assertGoogleTokenValid(profileId);

  // Pull before anything opens the DB, or a stale DB re-scores postings the other machine handled.
  await syncBeforeRun(profileId);

  const { runOnceAfterSync, releaseDbForSync } = await import("./runOnce.js");
  await runOnceAfterSync(profileId);

  releaseDbForSync();
  await syncAfterRun(profileId);
  stopConnectivity();
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof LlmUnavailableError || err instanceof GoogleAuthExpiredError) {
    logger.error(`aborting — ${err.message}`);
  } else {
    logger.error({ err: String(err) }, "fatal");
  }
  process.exit(1);
});
