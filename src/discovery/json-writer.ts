import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import type { RegistryEntry } from "../types.js";

function kebabCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function entryKey(e: { source?: string; source_slug?: string | null; name: string }): string {
  const slug = e.source_slug && e.source_slug.length > 0 ? e.source_slug : kebabCase(e.name);
  return `${e.source ?? "custom"}::${slug}`;
}

function registryPath(): string {
  return resolve(process.cwd(), config.storage.registryPath);
}

function readJsonArray(path: string): RegistryEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as RegistryEntry[]) : [];
  } catch {
    return [];
  }
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

function writeAtomic(path: string, entries: RegistryEntry[]): void {
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

export function knownEntryKeys(filePath: string = registryPath()): Set<string> {
  return new Set(readJsonArray(filePath).map(entryKey));
}

export function knownCompanyNames(filePath: string = registryPath()): Set<string> {
  return new Set(readJsonArray(filePath).map((e) => kebabCase(e.name)));
}

export { entryKey, kebabCase };
