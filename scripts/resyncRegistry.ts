// Run after any registry write: prune removes stale provider/slug rows a repoint left; `pruned` is 0 unless every row validated (check `invalidRows`).
import "dotenv/config";
import { syncRegistryFromSheet } from "../src/registry/sheetRegistry.js";

const i = process.argv.indexOf("--profile");
const profileId = (i >= 0 ? process.argv[i + 1] : undefined) ?? "default";
const result = await syncRegistryFromSheet(profileId);
console.log(JSON.stringify(result, null, 1));
