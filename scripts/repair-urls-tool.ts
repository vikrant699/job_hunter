/** Probe failed-URL companies, try path variants + Brave Search, and optionally write fixes. */
import "dotenv/config";
import { syncRegistryFromJson } from "../src/registry/companies.js";
import { repairBrokenUrls } from "./url-repair.js";

function parseArgs(): { dryRun: boolean; onlyNames: string[] } {
  const args = process.argv.slice(2);
  const applyIdx = args.indexOf("--apply");
  if (applyIdx < 0) return { dryRun: true, onlyNames: [] };

  const next = args[applyIdx + 1];
  if (next && !next.startsWith("--")) {
    return { dryRun: false, onlyNames: next.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  return { dryRun: false, onlyNames: [] };
}

async function main(): Promise<void> {
  const { dryRun, onlyNames } = parseArgs();

  syncRegistryFromJson();

  console.log("\n=== URL Repair " + (dryRun ? "(DRY RUN — no changes will be written)" : "(APPLYING)") + " ===");
  if (onlyNames.length > 0) console.log(`Limited to: ${onlyNames.join(", ")}`);
  console.log();

  const r = await repairBrokenUrls({ dryRun, onlyNames: onlyNames.length > 0 ? onlyNames : undefined });

  console.log(`Attempted:           ${r.attempted}`);
  console.log(`Would fix (or did):  ${r.fixed}  (path-variant: ${r.fixedByPathVariant}, brave: ${r.fixedByBraveSearch})`);
  console.log(`Still broken:        ${r.stillBroken.length}`);
  console.log(`Brave queries used:  ${r.braveQueriesUsed}`);
  console.log();

  if (r.fixes.length > 0) {
    console.log("--- Proposed fixes ---");
    for (const f of r.fixes) {
      console.log(`  [${f.via.padEnd(13)}]  ${f.name.padEnd(32)}`);
      console.log(`    old: ${f.oldUrl}`);
      console.log(`    new: ${f.newUrl}`);
    }
    console.log();
  }
  if (r.stillBroken.length > 0) {
    console.log("--- Still broken (need manual intervention) ---");
    for (const s of r.stillBroken.slice(0, 30)) {
      console.log(`  ${s.name.padEnd(32)}  ${s.careersUrl}`);
    }
    if (r.stillBroken.length > 30) console.log(`  ... +${r.stillBroken.length - 30} more`);
    console.log();
  }
  if (r.errors.length > 0) {
    console.log("--- Errors ---");
    for (const e of r.errors) console.log(`  ${e}`);
    console.log();
  }

  if (dryRun) {
    console.log("Dry run — nothing was written.");
    console.log("To apply ALL proposed fixes:");
    console.log("  npm run repair-urls -- --apply");
    console.log("To apply only specific entries:");
    console.log("  npm run repair-urls -- --apply 'MPL,Moglix,Amazon'");
  } else {
    console.log(r.fixes.length > 0
      ? `Applied ${r.fixes.length} fixes to data/companies.json + DB.`
      : "No fixes to apply.");
  }
}

main().catch((err) => { console.error(`repair-urls-tool failed: ${err}`); process.exit(1); });
