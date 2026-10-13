import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { readTab as defaultReadTab, appendRows as defaultAppendRows, updateRange as defaultUpdateRange } from "../google/sheets.js";
import type { RegistryEntry } from "../schemas.js";
import { entryToRow, rowToEntry, REGISTRY_COLUMNS } from "./sheetCodec.js";
import { writeAtomic } from "../util/registryFile.js";
import { registryKey as entryKey } from "../util/slug.js";

export interface RegistryWriterDeps {
  readTab: (profileId: string, tab: string) => Promise<string[][]>;
  appendRows: (profileId: string, tab: string, rows: string[][]) => Promise<void>;
  updateRange: (profileId: string, rangeA1: string, rows: string[][]) => Promise<void>;
  cachePath: string;
}

function defaultCachePath(): string {
  return resolve(process.cwd(), "data/registry-cache.json");
}

function defaultDeps(): RegistryWriterDeps {
  return {
    readTab: defaultReadTab,
    appendRows: defaultAppendRows,
    updateRange: defaultUpdateRange,
    cachePath: defaultCachePath(),
  };
}

function decodeValidRows(rows: string[][]): { entries: RegistryEntry[]; allValid: boolean } {
  const entries: RegistryEntry[] = [];
  let allValid = true;
  for (const row of rows.slice(1)) {
    const result = rowToEntry(row);
    if (result.ok) entries.push(result.entry);
    else allValid = false;
  }
  return { entries, allValid };
}

function mirrorToCache(cachePath: string, entries: RegistryEntry[], allValid: boolean): void {
  if (!allValid) {
    logger.warn({ cachePath }, "registry-writer: cache mirror skipped (tab has invalid rows)");
    return;
  }
  writeAtomic(cachePath, entries);
}

/** Tracks the raw row index separately so invalid rows above the match can't misalign it. */
function locateEntryRow(
  rows: string[][],
  key: string,
): { sheetRow: number; entry: RegistryEntry } | null {
  const dataRows = rows.slice(1);
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row) continue;
    const result = rowToEntry(row);
    if (result.ok && entryKey(result.entry) === key) {
      return { sheetRow: i + 2, entry: result.entry };
    }
  }
  return null;
}

export interface AppendResult {
  written: number;
  skippedDuplicates: number;
}

export async function appendToRegistry(
  newEntries: RegistryEntry[],
  profileId: string,
  deps: RegistryWriterDeps = defaultDeps(),
): Promise<AppendResult> {
  const rows = await deps.readTab(profileId, config.google.tabs.companies);
  const { entries: existing, allValid } = decodeValidRows(rows);
  const known = new Set(existing.map(entryKey));

  const toAdd: RegistryEntry[] = [];
  let skippedDuplicates = 0;
  for (const e of newEntries) {
    const k = entryKey(e);
    if (known.has(k)) { skippedDuplicates++; continue; }
    known.add(k);
    toAdd.push(e);
  }

  if (toAdd.length === 0) return { written: 0, skippedDuplicates };

  await deps.appendRows(profileId, config.google.tabs.companies, toAdd.map(entryToRow));
  mirrorToCache(deps.cachePath, [...existing, ...toAdd], allValid);
  return { written: toAdd.length, skippedDuplicates };
}

export async function updateRegistryEntry(
  key: { source: string; source_slug?: string | null | undefined; name: string },
  patch: Partial<RegistryEntry>,
  profileId: string,
  deps: RegistryWriterDeps = defaultDeps(),
): Promise<boolean> {
  const rows = await deps.readTab(profileId, config.google.tabs.companies);
  const located = locateEntryRow(rows, entryKey(key));
  if (!located) return false;

  const updated: RegistryEntry = { ...located.entry, ...patch };
  const lastCol = String.fromCharCode(64 + REGISTRY_COLUMNS.length);
  await deps.updateRange(
    profileId,
    `${config.google.tabs.companies}!A${located.sheetRow}:${lastCol}${located.sheetRow}`,
    [entryToRow(updated)],
  );

  const { entries, allValid } = decodeValidRows(rows);
  const idx = entries.findIndex((e) => entryKey(e) === entryKey(key));
  if (idx >= 0) entries[idx] = updated;
  mirrorToCache(deps.cachePath, entries, allValid);
  logger.info({ key: entryKey(key), patch: Object.keys(patch) }, "registry-writer: entry updated on the Companies tab");
  return true;
}

export async function updateRegistryStrategy(
  source: string,
  sourceSlug: string,
  name: string,
  strategy: RegistryEntry["parsing_strategy"],
  profileId: string,
  deps: RegistryWriterDeps = defaultDeps(),
): Promise<boolean> {
  const rows = await deps.readTab(profileId, config.google.tabs.companies);
  const located = locateEntryRow(rows, entryKey({ source, source_slug: sourceSlug, name }));
  if (!located || located.entry.parsing_strategy === strategy) return false;
  return updateRegistryEntry({ source, source_slug: sourceSlug, name }, { parsing_strategy: strategy }, profileId, deps);
}

