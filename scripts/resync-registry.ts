/**
 * Pull the Companies tab into the DB and report what happened.
 *
 * Needed after any registry write: the sheet is the source of truth, and a repoint that
 * changes a row's source/source_slug only lands in the DB once this runs — the prune pass
 * is what removes the old provider/slug row the scheduler would otherwise keep scraping.
 *
 * `pruned` is only non-zero when every row validated; a single invalid row disables prune
 * for the run (so one bad cell can't delete companies it doesn't mention). So if you expect
 * prunes and see zero, check `invalidRows` first.
 *
 * Run: `npx tsx scripts/resync-registry.ts`
 */
import "dotenv/config";
import { syncRegistryFromSheet } from "../src/registry/sheet-registry.js";

const result = await syncRegistryFromSheet("vikrant");
console.log(JSON.stringify(result, null, 1));
