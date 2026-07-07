/**
 * Probe failed-URL companies, try path variants + Brave Search, and report
 * proposed fixes. Dry-run by default; with --apply each fix is written to the
 * Companies tab (the registry source of truth), the local cache is mirrored,
 * and the DB url_suspect flag is cleared.
 *
 *   npm run repair-urls                                   dry run
 *   npm run repair-urls -- --apply --profile vikrant      write fixes to the tab
 *   npm run repair-urls -- --apply "Acme,Globex" --profile vikrant
 *
 * --apply needs --profile <name>: sheet writes use that profile's Google token.
 */
import "dotenv/config";
import { profile } from "../src/profile.js";
import { syncRegistryFromSheet } from "../src/registry/sheet-registry.js";
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
  const profileId = profile.id ?? "default";

  await syncRegistryFromSheet(profileId);

  console.log(`\n=== URL Repair (${dryRun ? "DRY RUN — no changes will be written" : `APPLY — writing fixes to the Companies tab as ${profileId}`}) ===`);
  if (onlyNames.length > 0) console.log(`Limited to: ${onlyNames.join(", ")}`);
  console.log();

  const r = await repairBrokenUrls({
    onlyNames: onlyNames.length > 0 ? onlyNames : undefined,
    apply: dryRun ? undefined : { profileId },
  });

  console.log(`Attempted:           ${r.attempted}`);
  console.log(`${dryRun ? "Would fix" : "Fixed"}:           ${r.fixed}  (path-variant: ${r.fixedByPathVariant}, brave: ${r.fixedByBraveSearch})`);
  if (!dryRun) console.log(`Applied to tab:      ${r.applied}`);
  console.log(`Still broken:        ${r.stillBroken.length}`);
  console.log(`Brave queries used:  ${r.braveQueriesUsed}`);
  console.log();

  if (r.fixes.length > 0) {
    console.log(dryRun ? "--- Proposed fixes ---" : "--- Fixes ---");
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

  console.log(
    dryRun
      ? "Nothing was written. Re-run with --apply --profile <name> to write these to the Companies tab."
      : `${r.applied} fix(es) written to the Companies tab; cache mirrored; url_suspect cleared.`,
  );
}

main().catch((err) => { console.error(`repair-urls-tool failed: ${err}`); process.exit(1); });
