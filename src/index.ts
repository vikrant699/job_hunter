import "dotenv/config";
import { logger } from "./logger.js";
import { syncRegistryFromJson } from "./registry/companies.js";
import { runProductionTick } from "./pipeline/index.js";
import { runDiscovery } from "./discovery/run.js";
import { emitDailyCsvs } from "./reports/daily-csvs.js";
import { assertOllamaAvailable, OllamaUnavailableError } from "./llm/client.js";

function printUsage(): void {
  console.log(`Usage: npm run <command>

  once       Run a single production tick: fetch postings → filter → notify Discord
  discover   Run discovery only: pull new candidate companies from configured sources
`);
}

async function runOnce(): Promise<void> {
  // Discovery is intentionally NOT part of a regular run — it's a separate step
  // (`npm run discover`) so nightly runs only fetch + filter + notify. The CSV
  // report therefore carries no discovery section (discovery: null).
  const outcome = await runProductionTick();

  try {
    await emitDailyCsvs({
      tickStartedAt: outcome.startedAtIso,
      tickEndedAt: outcome.endedAtIso,
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
  if (once) {
    await assertOllamaAvailable();
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
  // The Ollama guard is an expected, actionable stop — log just the message
  // (no stack noise) so the operator sees exactly what to fix.
  if (err instanceof OllamaUnavailableError) {
    logger.error(`aborting — ${err.message}`);
  } else {
    logger.error({ err: String(err) }, "fatal");
  }
  process.exit(1);
});
