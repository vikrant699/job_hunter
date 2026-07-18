import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { readTab as defaultReadTab } from "../google/sheets.js";
import type { RegistryEntry } from "../schemas.js";
import { writeAtomic } from "../util/registry-file.js";
import { readRegistryFile, syncEntries } from "./companies.js";
import { rowToEntry } from "./sheet-codec.js";

export interface InvalidRow {
  rowIndex: number;
  issues: string;
}

export interface RegistrySyncResult {
  source: "sheet" | "cache";
  synced: number;
  denied: number;
  pruned: number;
  invalidRows: InvalidRow[];
}

export interface SyncRegistryFromSheetDeps {
  readTab: (profileId: string, tab: string) => Promise<string[][]>;
  cachePath: string;
}

function defaultCachePath(): string {
  return resolve(process.cwd(), "data/registry-cache.json");
}

function defaultDeps(_profileId: string): SyncRegistryFromSheetDeps {
  return {
    readTab: (id: string, tab: string) => defaultReadTab(id, tab),
    cachePath: defaultCachePath(),
  };
}

/** Decode every data row (skipping the header), splitting into valid entries
 *  and quarantined issues keyed by the 1-based row index the user sees in the
 *  sheet UI (row 1 = header, so the first data row is row 2). */
function decodeRows(rows: string[][]): { entries: RegistryEntry[]; invalidRows: InvalidRow[] } {
  const entries: RegistryEntry[] = [];
  const invalidRows: InvalidRow[] = [];
  const dataRows = rows.slice(1);
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row) continue;
    const result = rowToEntry(row);
    if (result.ok) {
      entries.push(result.entry);
    } else {
      invalidRows.push({ rowIndex: i + 2, issues: result.issues });
    }
  }
  return { entries, invalidRows };
}

/**
 * Sync the company registry from the Companies tab of the outreach
 * spreadsheet (the source of truth the user hand-edits). Per-row validation
 * quarantines bad rows instead of aborting the whole sync; a single bad row
 * disables the prune pass for this run (a partial read must never look like
 * "everything else was deleted"). On a fully successful sheet read, the valid
 * entries are snapshotted to a local cache file so the bot can still run
 * offline (network/auth failure) — that fallback path trusts the cache fully
 * (prune: true) since it was written from a completely valid sync.
 */
export async function syncRegistryFromSheet(
  profileId: string,
  deps: SyncRegistryFromSheetDeps = defaultDeps(profileId),
): Promise<RegistrySyncResult> {
  let rows: string[][];
  try {
    rows = await deps.readTab(profileId, config.google.tabs.companies);
  } catch (err) {
    logger.warn(
      { profileId, err: String(err).slice(0, 200) },
      "STALE REGISTRY — Companies tab unreachable, falling back to data/registry-cache.json",
    );
    const cached = readRegistryFile(deps.cachePath);
    if (cached.length === 0) {
      throw new Error(
        `Companies tab unreachable (${String(err).slice(0, 160)}) and no local cache at ${deps.cachePath}. ` +
          `Run "npm run bootstrap-sheet" to seed the sheet, or check GOOGLE_CLIENT_ID / ` +
          `GOOGLE_CLIENT_SECRET / GOOGLE_SPREADSHEET_ID in .env.`,
      );
    }
    const result = syncEntries(cached, { prune: true });
    logger.info({ ...result, source: "cache" }, "registry synced from cache");
    return { source: "cache", invalidRows: [], ...result };
  }

  const { entries, invalidRows } = decodeRows(rows);
  if (invalidRows.length > 0) {
    logger.warn(
      { profileId, invalidRows },
      "registry sync: quarantined invalid Companies-tab rows — prune disabled this run",
    );
  }
  // A successful read with ZERO valid entries is treated as a suspect read
  // (cleared tab, API returning no `values`), not as "delete everything":
  // pruning here would wipe every company AND overwrite the offline cache
  // with an empty list, destroying both recovery paths in one tick.
  if (entries.length === 0) {
    logger.warn(
      { profileId },
      "registry sync: Companies tab returned zero valid rows — prune and cache snapshot disabled this run",
    );
  }
  const trustworthy = invalidRows.length === 0 && entries.length > 0;
  const result = syncEntries(entries, { prune: trustworthy });

  // Snapshot ONLY fully-valid syncs: the offline fallback path trusts the
  // cache with prune enabled, so a partial snapshot (quarantined rows missing)
  // would let a later offline run prune companies that still exist on the
  // sheet but had a cell typo at snapshot time.
  if (trustworthy) {
    writeAtomic(deps.cachePath, entries);
  } else {
    logger.warn({ cachePath: deps.cachePath }, "registry sync: cache snapshot skipped (sheet read not trustworthy)");
  }

  logger.info({ ...result, source: "sheet", invalidRowCount: invalidRows.length }, "registry synced");
  return { source: "sheet", invalidRows, ...result };
}
