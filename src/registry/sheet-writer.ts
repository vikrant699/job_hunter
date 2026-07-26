import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { readTab as defaultReadTab, appendRows as defaultAppendRows, updateRange as defaultUpdateRange } from "../google/sheets.js";
import type { RegistryEntry } from "../schemas.js";
import { entryToRow, rowToEntry, REGISTRY_COLUMNS } from "./sheet-codec.js";
import { writeAtomic } from "../util/registry-file.js";
import { registryKey as entryKey } from "../util/slug.js";

/**
 * Registry-mutation surface for the Companies tab (the registry source of
 * truth): the SPA sentinel's strategy writeback and the append path used by
 * registry-maintenance scripts/sessions. Every write also mirrors into
 * data/registry-cache.json so the local cache stays a faithful snapshot for
 * the offline fallback in sheet-registry.ts.
 */

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

/** Decode the tab's data rows, ignoring any that fail validation — callers of
 *  this module only need the identity/lookup surface (keys, names, cells),
 *  not a full quarantine report (that lives in sheet-registry.ts). A row that
 *  fails to decode simply can't collide with a new addition by key.
 *  `allValid` reports whether ANY row was dropped — cache mirroring must skip
 *  partial decodes (same rule as sheet-registry.ts: the offline fallback
 *  prunes from the cache, so a partial snapshot would delete quarantined
 *  companies on a later offline run). */
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

/** Locate the sheet row (1-based, header-inclusive) and decoded entry for a
 *  registry key. Tracks the RAW row index separately from the valid-entries
 *  array so rows that fail validation above the match can't misalign it. */
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

/**
 * Append new registry entries to the Companies tab, skipping any whose
 * (source, slug) key already exists. Mirrors the appended entries into the
 * local cache so an immediately-following offline run still sees them.
 */
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

/**
 * Patch arbitrary fields of one registry entry in place on the Companies tab
 * (full-row rewrite at the located row, other rows untouched), mirroring the
 * cache. Used by updateRegistryStrategy and registry-maintenance sessions.
 * Returns false when no row matches the key.
 */
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
  const lastCol = String.fromCharCode(64 + REGISTRY_COLUMNS.length); // 14 cols -> "N"
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

/**
 * Patch one entry's parsing_strategy cell in place (other columns untouched).
 * Used by the SPA sentinel to make its llm-scrape -> playwright-llm-scrape
 * recommendation stick — a DB-only flip would be reverted by the next
 * syncRegistryFromSheet. Returns false when no row matches the key.
 */
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

