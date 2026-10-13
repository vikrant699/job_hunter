// Preloaded first by `npm test` so db.ts opens a throwaway DB, not the production one whose fixture rows would reach the real Google Sheet.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.JOB_HUNTER_DB_PATH) {
  process.env.JOB_HUNTER_DB_PATH = join(mkdtempSync(join(tmpdir(), "job-hunter-test-")), "test.db");
}
