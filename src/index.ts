import "dotenv/config";
import { logger } from "./logger.js";
import { assertLlmAvailable } from "./llm/client.js";
import { LlmUnavailableError } from "./llm/errors.js";
import { assertGoogleTokenValid, GoogleAuthExpiredError } from "./google/auth.js";
import { syncBeforeRun, syncAfterRun } from "./db/sync.js";
import { startConnectivityMonitor } from "./util/connectivity.js";
import { profile } from "./profile.js";

// NOTHING in this file's static imports may reach src/db/db.ts. That module opens
// the SQLite file when it loads, and syncBeforeRun replaces that file - so the
// run's body lives in ./runOnce.ts and is reached by dynamic import AFTER the
// sync. src/__tests__/indexImportGraph.test.ts pins the rule.

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

  // Start watching connectivity BEFORE the pre-flights. A run launched while the
  // connection happens to be down should wait for it rather than exit — and from
  // here on, every outbound call (boards, JDs, OpenRouter, Sheets/Gmail/Drive)
  // pauses during an outage and resumes exactly where it left off, instead of
  // failing its way through the company list. The wait is deliberately unbounded.
  const stopConnectivity = startConnectivityMonitor();

  // A production tick needs the LLM backend — check it before the (~30s)
  // registry sync so a down Ollama or a bad OpenRouter key/model fails in seconds
  // with a clear message. (runProductionTick re-checks, so programmatic callers
  // stay protected too.) The Google token check is likewise fail-fast pre-flight:
  // abort BEFORE any scraping so a revoked/expired refresh token surfaces
  // immediately, instead of discovering it only after a multi-hour tick when
  // outreach runs.
  await assertLlmAvailable();
  await assertGoogleTokenValid(profileId);

  // Pull a newer DB from Drive BEFORE anything opens it. Running against a stale
  // database makes postingExists() miss postings the other machine already
  // handled, which re-scores them and drafts duplicate emails to recruiters who
  // were already contacted.
  await syncBeforeRun(profileId);

  // Only now is it safe to load the DB-backed half of the app.
  const { runOnceAfterSync, releaseDbForSync } = await import("./runOnce.js");
  await runOnceAfterSync(profileId);

  // Push the finished state so the other machine can pick up where this left off.
  // Best-effort by design: a Drive failure here must not fail a completed run.
  releaseDbForSync();
  await syncAfterRun(profileId);
  stopConnectivity();
  process.exit(0);
}

main().catch((err) => {
  // The LLM/Google pre-flight guards are expected, actionable stops — log
  // just the message (no stack noise) so the operator sees exactly what to fix.
  if (err instanceof LlmUnavailableError || err instanceof GoogleAuthExpiredError) {
    logger.error(`aborting — ${err.message}`);
  } else {
    logger.error({ err: String(err) }, "fatal");
  }
  process.exit(1);
});
