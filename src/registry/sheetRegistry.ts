import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { readTab as defaultReadTab } from "../google/sheets.js";
import type { RegistryEntry } from "../schemas.js";
import { writeAtomic } from "../util/registryFile.js";
import { readRegistryFile, syncEntries } from "./companies.js";
import { rowToEntry } from "./sheetCodec.js";

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

/** Decodes data rows into valid entries + quarantined issues, keyed by 1-based sheet row index (row 1 = header). */
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

/** Syncs the registry from the Companies tab; a bad row is quarantined and disables prune for the run (a partial read must never look like "everything else was deleted"). Valid syncs are snapshotted to a local cache for offline fallback. */
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
  // A read with ZERO valid entries is treated as suspect, not "delete everything" - pruning would wipe both the DB and the offline cache.
  if (entries.length === 0) {
    logger.warn(
      { profileId },
      "registry sync: Companies tab returned zero valid rows — prune and cache snapshot disabled this run",
    );
  }
  const trustworthy = invalidRows.length === 0 && entries.length > 0;
  const result = syncEntries(entries, { prune: trustworthy });

  // Snapshot only fully-valid syncs - a partial snapshot would let a later offline run prune still-valid companies.
  if (trustworthy) {
    writeAtomic(deps.cachePath, entries);
  } else {
    logger.warn({ cachePath: deps.cachePath }, "registry sync: cache snapshot skipped (sheet read not trustworthy)");
  }

  logger.info({ ...result, source: "sheet", invalidRowCount: invalidRows.length }, "registry synced");
  return { source: "sheet", invalidRows, ...result };
}
