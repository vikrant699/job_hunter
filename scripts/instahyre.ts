// Standalone Instahyre auto-apply run; skips fast when the profile has no INSTAHYRE_EMAIL_<NAME>/INSTAHYRE_PASSWORD_<NAME>, or when the feed has no jobs.
import "dotenv/config";
import { profile } from "../src/profile.js";
import { runInstahyreAutoApply } from "../src/instahyre/autoApply.js";
import { logger } from "../src/logger.js";
import type { Caught } from "../src/util/errorCause.js";

async function main(): Promise<void> {
  const result = await runInstahyreAutoApply(profile.id ?? "default");
  logger.info(result, "instahyre run complete");
}

main().catch((err: Caught) => {
  logger.error({ err: String(err) }, "instahyre failed");
  process.exitCode = 1;
});
