/**
 * Pulls the Companies tab into the DB and reports what happened.
 *   npx tsx scripts/resyncRegistry.ts
 * Needed after any registry write - the prune pass removes stale provider/slug rows a repoint
 * left behind. `pruned` is only non-zero when every row validated; check `invalidRows` first
 * if you expect prunes and see zero.
 */
import "dotenv/config";
import { syncRegistryFromSheet } from "../src/registry/sheetRegistry.js";

const result = await syncRegistryFromSheet("vikrant");
console.log(JSON.stringify(result, null, 1));
