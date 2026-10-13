// Loaded via dynamic import post-sync: these modules open db/db.ts at load, which the pre-run Drive pull must not race.
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
import { getCacheStats, cachedPercent } from "./llm/openrouter.js";

async function runTickAndOutreach(
  profileId: string,
  registryResult: RegistrySyncResult,
): Promise<void> {
  const outcome = await runProductionTick();

  let verifyResult: VerifyResult | null = null;
  let outreachResult: RunOutreachResult | null = null;
  let outreachError: string | null = null;
  try {
    // Verify first so yesterday's bounces are marked before today's contact matching.
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
      // A stale/revoked Google token must not crash the process after scrape results are saved.
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

const CACHE_WARN_MIN_CALLS = 50;
const CACHE_WARN_BELOW_PCT = 50;

function logCacheStats(): void {
  const stats = getCacheStats();
  if (stats.calls === 0) return;
  const cachedPct = cachedPercent(stats);
  logger.info({ ...stats, cachedPct, model: config.llm.openRouterModel }, "llm run totals");
  // The resume+rubric prefix is ~80% of a gate prompt; a much lower cache rate means the pin isn't holding.
  if (stats.calls >= CACHE_WARN_MIN_CALLS && cachedPct < CACHE_WARN_BELOW_PCT) {
    logger.warn(
      { cachedPct, providers: stats.providers, pinned: config.llm.openRouterProviders },
      "llm prompt-cache hit rate is low - check OPENROUTER_PROVIDERS",
    );
  }
}

export async function runOnceAfterSync(profileId: string): Promise<void> {
  const registryResult = await syncRegistryFromSheet(profileId);
  await runTickAndOutreach(profileId, registryResult);
  logCacheStats();
}

/** Close before the post-run push, which WAL-checkpoints; a still-open DB reports busy and half-checkpoints silently. */
export function releaseDbForSync(): void {
  closeDb();
}
