import "dotenv/config";
import { logger } from "./logger.js";
import { syncRegistryFromJson } from "./registry/companies.js";
import { runProductionTick } from "./pipeline.js";
import { runDiscovery, type DiscoveryResult } from "./discovery/run.js";
import { emitDailyCsvs } from "./reports/daily-csvs.js";

function printUsage(): void {
  console.log(`Usage: npm run <command>

  once       Run a single production tick: fetch postings → filter → notify Discord
  discover   Run discovery only: pull new candidate companies from configured sources
`);
}

async function runOnce(): Promise<void> {
  const outcome = await runProductionTick();

  let discovery: DiscoveryResult | null = null;
  try {
    logger.info("starting discovery");
    discovery = await runDiscovery();
    logger.info(
      {
        added: discovery.additions.length,
        skipped: discovery.skipped.length,
        braveQuotaUsed: `${discovery.braveQuotaUsed}/${discovery.braveQuotaCap}`,
      },
      "discovery complete",
    );
  } catch (err) {
    logger.error({ err: String(err) }, "discovery threw; tick still completed");
  }

  try {
    await emitDailyCsvs({
      tickStartedAt: outcome.startedAtIso,
      tickEndedAt: outcome.endedAtIso,
      discovery,
      stats: outcome.stats,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "report emit threw");
  }

  if (discovery && discovery.additions.length > 0) {
    try {
      syncRegistryFromJson();
    } catch (err) {
      logger.warn({ err: String(err) }, "post-discovery registry resync failed");
    }
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
  logger.error({ err: String(err) }, "fatal");
  process.exit(1);
});
