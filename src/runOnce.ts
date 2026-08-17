// Body of `npm run once`, everything after the DB sync. Split from index.ts because these modules transitively open
// db/db.ts at load, which the pre-run Drive pull must not race; index.ts reaches this via dynamic import post-sync,
// and db/openState.ts enforces the rule at runtime.
import { logger } from "./logger.js";
import { syncRegistryFromSheet } from "./registry/sheetRegistry.js";
import type { RegistrySyncResult } from "./registry/sheetRegistry.js";
import { runProductionTick } from "./pipeline/index.js";
import { GoogleAuthExpiredError } from "./google/auth.js";
import { runOutreach } from "./outreach/run.js";
import type { RunOutreachResult } from "./outreach/run.js";
import { runVerify } from "./outreach/verify.js";
import type { VerifyResult } from "./outreach/verify.js";
import { projectToSheet } from "./outreach/sheetSync.js";
import { postRunStatus } from "./discord/status.js";
import { closeDb } from "./db/db.js";
import { config } from "./config.js";
import { getCacheStats } from "./llm/openrouter.js";

async function runTickAndOutreach(
  profileId: string,
  registryResult: RegistrySyncResult,
): Promise<void> {
  const outcome = await runProductionTick();

  let verifyResult: VerifyResult | null = null;
  let outreachResult: RunOutreachResult | null = null;
  let outreachError: string | null = null;
  try {
    // Verify runs first so yesterday's bounces mark 'bounced' before today's contact matching, or a dead address gets re-drafted.
    verifyResult = await runVerify({ profileId, runId: outcome.runId });
    outreachResult = await runOutreach({ profileId, sinceIso: outcome.startedAtIso, runId: outcome.runId });
    await projectToSheet(profileId, outcome.runId);
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
      // Scrape results are already saved; a stale/revoked Google token must not crash the process.
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

/** Report the hosted provider's prompt cache totals for the run (cached vs uncached input is a ~4x cost difference). */
function logCacheStats(): void {
  if (config.llm.local) return;
  const stats = getCacheStats();
  if (stats.calls === 0) return;
  const cachedPct =
    stats.promptTokens > 0 ? Math.round((100 * stats.cachedTokens) / stats.promptTokens) : 0;
  logger.info({ ...stats, cachedPct, model: config.llm.openRouterModel }, "llm run totals");
}

/** The whole run, from registry sync to Discord status. Assumes the DB is current. */
export async function runOnceAfterSync(profileId: string): Promise<void> {
  const registryResult = await syncRegistryFromSheet(profileId);
  await runTickAndOutreach(profileId, registryResult);
  logCacheStats();
}

/** Close the DB before the post-run push, which WAL-checkpoints it; still-open reports busy and half-checkpoints silently. Terminal - nothing may touch the DB after this. */
export function releaseDbForSync(): void {
  closeDb();
}
