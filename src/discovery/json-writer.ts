import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import type { RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema } from "../schemas.js";
import { kebabCase, registryKey as entryKey } from "../util/slug.js";

function registryPath(): string {
  return resolve(process.cwd(), config.storage.registryPath);
}

// Loud on corrupt/invalid content: callers atomically overwrite this file, so
// silently mapping a malformed byte to [] would let one bad write destroy the
// whole registry. A genuinely missing file (fresh checkout, first run) is the
// only case allowed to mean "empty". Mirrors readRegistryFile in
// src/registry/companies.ts.
function readJsonArray(path: string): RegistryEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry file ${path} is not valid JSON: ${err}`);
  }
  const result = RegistryEntrySchema.array().safeParse(parsed);
  if (!result.success) {
    throw new Error(`registry file ${path} failed validation: ${result.error.issues.slice(0, 5).map((i) => i.message).join("; ")}`);
  }
  return result.data;
}

/** Stable order so discovery/repair edits produce small, readable git diffs. */
function sortEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return [...entries].sort((a, b) => {
    const sa = a.source ?? "custom", sb = b.source ?? "custom";
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ka = a.source_slug && a.source_slug.length > 0 ? a.source_slug : kebabCase(a.name);
    const kb = b.source_slug && b.source_slug.length > 0 ? b.source_slug : kebabCase(b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Atomically overwrite `path` with `entries` (write to a temp file, then
 * rename). Exported for reuse by sheet-registry.ts's cache snapshot writes —
 * same crash-safety requirement (a snapshot write must never leave a
 * half-written data/registry-cache.json behind).
 */
export function writeAtomic(path: string, entries: RegistryEntry[]): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  try { renameSync(tmp, path); }
  catch (err) { try { unlinkSync(tmp); } catch { /* ignore */ } throw err; }
}

export function appendToRegistry(
  newEntries: RegistryEntry[], filePath: string = registryPath(),
): { written: number; skippedDuplicates: number; path: string } {
  const existing = readJsonArray(filePath);
  const known = new Set(existing.map(entryKey));
  const toAdd: RegistryEntry[] = [];
  let skippedDuplicates = 0;
  for (const e of newEntries) {
    const k = entryKey(e);
    if (known.has(k)) { skippedDuplicates++; continue; }
    known.add(k); toAdd.push(e);
  }
  if (toAdd.length === 0) return { written: 0, skippedDuplicates, path: filePath };
  writeAtomic(filePath, sortEntries([...existing, ...toAdd]));
  return { written: toAdd.length, skippedDuplicates, path: filePath };
}

export function upsertRegistry(
  entries: RegistryEntry[], filePath: string = registryPath(),
): { replaced: number; added: number; path: string } {
  const existing = readJsonArray(filePath);
  const byKey = new Map<string, number>();
  existing.forEach((e, i) => byKey.set(entryKey(e), i));
  let replaced = 0, added = 0;
  for (const e of entries) {
    const k = entryKey(e);
    const idx = byKey.get(k);
    if (idx !== undefined) { existing[idx] = e; replaced++; }
    else { existing.push(e); byKey.set(k, existing.length - 1); added++; }
  }
  if (replaced === 0 && added === 0) return { replaced: 0, added: 0, path: filePath };
  writeAtomic(filePath, sortEntries(existing));
  return { replaced, added, path: filePath };
}

/**
 * Patch one entry's parsing_strategy in place (other fields untouched).
 * Used by the SPA sentinel to make its llm-scrape -> playwright-llm-scrape
 * recommendation stick — a DB-only flip would be reverted by the next
 * syncRegistryFromJson. Returns false when no entry matches the key.
 */
export function updateRegistryStrategy(
  source: string,
  sourceSlug: string,
  name: string,
  strategy: RegistryEntry["parsing_strategy"],
  filePath: string = registryPath(),
): boolean {
  const existing = readJsonArray(filePath);
  const key = entryKey({ source, source_slug: sourceSlug, name });
  const idx = existing.findIndex((e) => entryKey(e) === key);
  const entry = idx >= 0 ? existing[idx] : undefined;
  if (!entry || entry.parsing_strategy === strategy) return false;
  entry.parsing_strategy = strategy;
  writeAtomic(filePath, sortEntries(existing));
  return true;
}

export function knownEntryKeys(filePath: string = registryPath()): Set<string> {
  return new Set(readJsonArray(filePath).map(entryKey));
}

export function knownCompanyNames(filePath: string = registryPath()): Set<string> {
  return new Set(readJsonArray(filePath).map((e) => kebabCase(e.name)));
}

// entryKey retained as the public name (run.ts imports it); it is now a thin
// alias for the shared util/slug.ts#registryKey used across the registry pipeline.
export { entryKey, kebabCase };
