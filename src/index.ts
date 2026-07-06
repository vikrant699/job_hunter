import "dotenv/config";
import { logger } from "./logger.js";
import { syncRegistryFromJson } from "./registry/companies.js";
import { runProductionTick } from "./pipeline/index.js";
import { runDiscovery } from "./discovery/run.js";
import { emitDailyCsvs } from "./reports/daily-csvs.js";
import { assertOllamaAvailable, OllamaUnavailableError } from "./llm/client.js";
import { assertGoogleTokenValid, GoogleAuthExpiredError } from "./google/auth.js";
import { runOutreach } from "./outreach/run.js";
import { profile } from "./profile.js";

function printUsage(): void {
  console.log(`Usage: npm run <command> [-- --profile <name>]

  once       Run a single production tick for one profile: fetch → filter → notify
  discover   Run discovery only: pull new candidate companies from configured sources

  --profile <name>   Use config/profiles/<name>/ (profile.ts + resume.pdf) and that
                     profile's webhook. Omit for the default (config/profile.ts).
`);
}

async function runOnce(): Promise<void> {
  // Discovery is intentionally NOT part of a regular run — it's a separate step
  // (`npm run discover`) so nightly runs only fetch + filter + notify. The CSV
  // report therefore carries no discovery section (discovery: null).
  const outcome = await runProductionTick();
  const profileId = profile.id ?? "default";

  try {
    await runOutreach({ profileId, sinceIso: outcome.startedAtIso, runId: null });
  } catch (err) {
    if (err instanceof GoogleAuthExpiredError) {
      // Scrape results are already saved — a stale/revoked Google token must
      // not crash the process. Log the exact renewal command and move on.
      logger.error({ err: err.message }, "outreach skipped — Google auth expired");
    } else {
      logger.error({ err: String(err) }, "outreach stage threw");
    }
  }

  try {
    await emitDailyCsvs({
      tickStartedAt: outcome.startedAtIso,
      tickEndedAt: outcome.endedAtIso,
      profileId,
      discovery: null,
      stats: outcome.stats,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "report emit threw");
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--help") || args.has("-h")) {
    printUsage();
    process.exit(0);
  }

  const once = args.has("--once");
  const discover = args.has("--discover");

  if (!once && !discover) {
    printUsage();
    process.exit(1);
  }

  // A production tick needs the LLM backend — check it before the (~30s)
  // registry sync so a down Ollama fails in seconds with a clear message.
  // (runProductionTick re-checks, so programmatic callers stay protected too.)
  // The Google token check is likewise fail-fast pre-flight: abort BEFORE any
  // scraping so a revoked/expired refresh token surfaces immediately, instead
  // of discovering it only after a multi-hour tick when outreach runs.
  if (once) {
    await assertOllamaAvailable();
    await assertGoogleTokenValid(profile.id ?? "default");
  }

  syncRegistryFromJson();

  if (discover) {
    const r = await runDiscovery();
    logger.info(
      { added: r.additions.length, skipped: r.skipped.length, braveQuotaUsed: r.braveQuotaUsed },
      "discovery-only run complete",
    );
    process.exit(0);
  }

  await runOnce();
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
