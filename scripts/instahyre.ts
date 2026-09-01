/**
 * Standalone Instahyre auto-apply run (phase 0 of `npm run once`, runnable on its own).
 *   npm run instahyre -- --profile vikrant
 * Skips fast when the profile has no INSTAHYRE_EMAIL_<NAME>/INSTAHYRE_PASSWORD_<NAME>, or when the feed has no jobs.
 */
import "dotenv/config";
import { profile } from "../src/profile.js";
import { runInstahyreAutoApply } from "../src/instahyre/autoApply.js";
import { logger } from "../src/logger.js";

async function main(): Promise<void> {
  const result = await runInstahyreAutoApply(profile.id ?? "default");
  logger.info(result, "instahyre run complete");
}

// eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
main().catch((err: unknown) => {
  logger.error({ err: String(err) }, "instahyre failed");
  process.exitCode = 1;
});
