// Pulls the Companies tab into the DB; run after any registry write since the prune pass removes stale provider/slug rows a repoint left behind. `pruned` is only non-zero when every row validated - check `invalidRows` first if you expect prunes and see zero.
import "dotenv/config";
import { syncRegistryFromSheet } from "../src/registry/sheetRegistry.js";

const i = process.argv.indexOf("--profile");
const profileId = (i >= 0 ? process.argv[i + 1] : undefined) ?? "default";
const result = await syncRegistryFromSheet(profileId);
console.log(JSON.stringify(result, null, 1));
