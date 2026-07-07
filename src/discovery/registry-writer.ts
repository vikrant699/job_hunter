import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { readTab as defaultReadTab, appendRows as defaultAppendRows, updateRange as defaultUpdateRange } from "../google/sheets.js";
import type { RegistryEntry } from "../schemas.js";
import { entryToRow, rowToEntry, REGISTRY_COLUMNS } from "../registry/sheet-codec.js";
import { readRegistryFile } from "../registry/companies.js";
import { writeAtomic } from "../util/registry-file.js";
import { registryKey as entryKey, kebabCase } from "../util/slug.js";

/**
 * Registry-mutation surface for discovery/runtime callers, writing against
 * the Companies tab (the registry source of truth). Every write also mirrors
 * into data/registry-cache.json so the local cache stays a faithful snapshot
 * for the offline fallback in sheet-registry.ts.
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
 *  fails to decode simply can't collide with a new addition by key. */
function decodeValidRows(rows: string[][]): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const row of rows.slice(1)) {
    const result = rowToEntry(row);
    if (result.ok) entries.push(result.entry);
  }
  return entries;
}

function mirrorToCache(cachePath: string, entries: RegistryEntry[]): void {
  writeAtomic(cachePath, entries);
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
  const existing = decodeValidRows(rows);
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
  mirrorToCache(deps.cachePath, [...existing, ...toAdd]);
  return { written: toAdd.length, skippedDuplicates };
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
  const key = entryKey({ source, source_slug: sourceSlug, name });

  let matchIndex = -1;
  const entries: RegistryEntry[] = [];
  const dataRows = rows.slice(1);
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row) continue;
    const result = rowToEntry(row);
    if (!result.ok) continue;
    entries.push(result.entry);
    if (matchIndex < 0 && entryKey(result.entry) === key) matchIndex = i;
  }

  if (matchIndex < 0) return false;
  const current = entries[matchIndex];
  if (!current || current.parsing_strategy === strategy) return false;

  const sheetRow = matchIndex + 2; // +1 for header, +1 for 1-based sheet rows
  const colLetter = String.fromCharCode(65 + REGISTRY_COLUMNS.indexOf("parsing_strategy"));
  await deps.updateRange(profileId, `${config.google.tabs.companies}!${colLetter}${sheetRow}`, [[strategy]]);

  entries[matchIndex] = { ...current, parsing_strategy: strategy };
  mirrorToCache(deps.cachePath, entries);
  logger.info({ source, sourceSlug, strategy }, "registry-writer: parsing_strategy flipped on the Companies tab");
  return true;
}

/** Known (source,slug) keys, read straight from the tab. */
export async function knownEntryKeys(
  profileId: string,
  deps: RegistryWriterDeps = defaultDeps(),
): Promise<Set<string>> {
  const rows = await deps.readTab(profileId, config.google.tabs.companies);
  return new Set(decodeValidRows(rows).map(entryKey));
}

/** Known company names (kebab-cased), read straight from the tab. */
export async function knownCompanyNames(
  profileId: string,
  deps: RegistryWriterDeps = defaultDeps(),
): Promise<Set<string>> {
  const rows = await deps.readTab(profileId, config.google.tabs.companies);
  return new Set(decodeValidRows(rows).map((e) => kebabCase(e.name)));
}

export { entryKey, kebabCase };

// Re-exported for callers that only need to read the last-known-good snapshot
// without hitting the network (e.g. a read path that's fine with staleness).
export function readCachedRegistry(cachePath: string = defaultCachePath()): RegistryEntry[] {
  return readRegistryFile(cachePath);
}
