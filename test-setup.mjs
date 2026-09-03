// Preloaded FIRST by `npm test` so src/db/db.ts opens a throwaway per-run DB instead of the production data/job_hunter.db, which would otherwise get real fixture rows and project them onto the user's real Google Sheet.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JOB_HUNTER_DB_PATH) {
  process.env.JOB_HUNTER_DB_PATH = join(mkdtempSync(join(tmpdir(), "job-hunter-test-")), "test.db");
}
