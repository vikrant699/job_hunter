// src/runOnce.ts - the body of `npm run once`, everything after the DB sync.
//
// Split out of index.ts for one structural reason: importing any of these modules
// transitively imports db/db.ts, which OPENS the SQLite file at module load. The
// pre-run Drive pull replaces that file, so it has to happen while nothing holds
// it - which means index.ts must not import this module statically. It reaches it
// with a dynamic import once the sync is done. db/openState.ts enforces the rule
// at runtime so the split cannot silently rot.
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

/**
 * Report what the hosted provider's prompt cache actually did over the run.
 * Cached vs uncached input is roughly a 4x cost difference, so the end-of-run
 * total is the number worth seeing - the every-100-calls line during a sweep
 * scrolls past.
 */
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

/**
 * Hand the database back before the post-run push. The push WAL-checkpoints the
 * file, which reports busy while this process still holds it open - and a
 * half-checkpointed upload is a backup silently missing its newest commits.
 * Terminal: nothing may touch the DB after this.
 */
export function releaseDbForSync(): void {
  closeDb();
}
