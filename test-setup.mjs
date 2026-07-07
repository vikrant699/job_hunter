// Preloaded FIRST by `npm test` (see package.json) so src/db/db.ts opens a
// throwaway per-run DB instead of the production data/job_hunter.db. Without
// this, test fixture rows land in the real DB — and since the outreach
// extension, sheet-sync would project those fixtures onto the user's real
// Google Sheet.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JOB_HUNTER_DB_PATH) {
  process.env.JOB_HUNTER_DB_PATH = join(mkdtempSync(join(tmpdir(), "job-hunter-test-")), "test.db");
}
