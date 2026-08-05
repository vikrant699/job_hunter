import "dotenv/config";
import { logger } from "./logger.js";
import { syncRegistryFromSheet } from "./registry/sheetRegistry.js";
import type { RegistrySyncResult } from "./registry/sheetRegistry.js";
import { runProductionTick } from "./pipeline/index.js";
import { assertOllamaAvailable, OllamaUnavailableError } from "./llm/client.js";
import { assertGoogleTokenValid, GoogleAuthExpiredError } from "./google/auth.js";
import { runOutreach } from "./outreach/run.js";
import type { RunOutreachResult } from "./outreach/run.js";
import { runVerify } from "./outreach/verify.js";
import type { VerifyResult } from "./outreach/verify.js";
import { projectToSheet } from "./outreach/sheetSync.js";
import { postRunStatus } from "./discord/status.js";
import { profile } from "./profile.js";

function printUsage(): void {
  console.log(`Usage: npm run <command> [-- --profile <name>]

  once       Run a single production tick for one profile: fetch → filter → notify

  --profile <name>   Use config/profiles/<name>/ (profile.ts + resume.pdf).
                     Omit for the default (config/profile.ts).
`);
}

async function runOnce(registryResult: RegistrySyncResult): Promise<void> {
  const outcome = await runProductionTick();
  const profileId = profile.id ?? "default";

  let verifyResult: VerifyResult | null = null;
  let outreachResult: RunOutreachResult | null = null;
  let outreachError: string | null = null;
  try {
    // Verify runs FIRST: yesterday's bounces must set the recruiter's status
    // to 'bounced' before today's runOutreach does its contact matching, or a
    // known-dead address would get drafted to again.
    verifyResult = await runVerify({ profileId, runId: outcome.runId });
    outreachResult = await runOutreach({ profileId, sinceIso: outcome.startedAtIso, runId: outcome.runId });
    await projectToSheet(profileId, outcome.runId);
    // The happy path above is otherwise silent — without this line a clean
    // run's log just stops at "production tick complete".
    logger.info(
      {
        profileId,
        draftsCreated: outreachResult.draftsCreated,
        undrafted: outreachResult.undrafted,
        companiesMatched: outreachResult.companiesMatched,
        verify: verifyResult,
      },
      "outreach stage complete; sheet projected",
    );
  } catch (err) {
    if (err instanceof GoogleAuthExpiredError) {
      // Scrape results are already saved — a stale/revoked Google token must
      // not crash the process. Log the exact renewal command and move on.
      logger.error({ err: err.message }, "outreach skipped — Google auth expired");
      outreachError = err.message;
    } else {
      logger.error({ err: String(err) }, "outreach stage threw");
      outreachError = String(err);
    }
  }

  try {
    await postRunStatus({
      profileId,
      stats: outcome.stats,
      outreach: outreachResult,
      outreachError,
      verify: verifyResult,
      registry: { source: registryResult.source, invalidRows: registryResult.invalidRows.length },
    });
  } catch (err) {
    logger.error({ err: String(err) }, "status post threw");
  }
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

  // A production tick needs the LLM backend — check it before the (~30s)
  // registry sync so a down Ollama fails in seconds with a clear message.
  // (runProductionTick re-checks, so programmatic callers stay protected too.)
  // The Google token check is likewise fail-fast pre-flight: abort BEFORE any
  // scraping so a revoked/expired refresh token surfaces immediately, instead
  // of discovering it only after a multi-hour tick when outreach runs.
  await assertOllamaAvailable();
  await assertGoogleTokenValid(profile.id ?? "default");

  const profileId = profile.id ?? "default";
  const registryResult = await syncRegistryFromSheet(profileId);

  await runOnce(registryResult);
  process.exit(0);
}

main().catch((err) => {
  // The Ollama/Google pre-flight guards are expected, actionable stops — log
  // just the message (no stack noise) so the operator sees exactly what to fix.
  if (err instanceof OllamaUnavailableError || err instanceof GoogleAuthExpiredError) {
    logger.error(`aborting — ${err.message}`);
  } else {
    logger.error({ err: String(err) }, "fatal");
  }
  process.exit(1);
});
