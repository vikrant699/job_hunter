import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { RegistryEntry } from "../types.js";

function kebabCase(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function entryKey(e: { source?: string; source_slug?: string | null; name: string }): string {
  const slug = e.source_slug && e.source_slug.length > 0 ? e.source_slug : kebabCase(e.name);
  return `${e.source ?? "custom"}::${slug}`;
}

function readJsonArray(path: string): RegistryEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RegistryEntry[]) : [];
  } catch (err) {
    logger.warn({ path, err: String(err).slice(0, 120) }, "json-writer: parse failed; treating as empty");
    return [];
  }
}

export function appendToWorkingJson(newEntries: RegistryEntry[]): { written: number; skippedDuplicates: number; path: string } {
  const seedPath = resolve(process.cwd(), config.storage.seedRegistryPath);
  const workingPath = resolve(process.cwd(), config.storage.workingRegistryPath);

  const seed = readJsonArray(seedPath);
  const working = readJsonArray(workingPath);

  const known = new Set<string>();
  for (const e of seed) known.add(entryKey(e));
  for (const e of working) known.add(entryKey(e));

  const toAdd: RegistryEntry[] = [];
  let skippedDuplicates = 0;
  for (const e of newEntries) {
    const key = entryKey(e);
    if (known.has(key)) {
      skippedDuplicates++;
      continue;
    }
    known.add(key);
    toAdd.push(e);
  }

  if (toAdd.length === 0) return { written: 0, skippedDuplicates, path: workingPath };

  writeAtomic(workingPath, [...working, ...toAdd]);
  return { written: toAdd.length, skippedDuplicates, path: workingPath };
}

export function upsertWorkingJson(entries: RegistryEntry[]): { replaced: number; added: number; path: string } {
  const workingPath = resolve(process.cwd(), config.storage.workingRegistryPath);
  const working = readJsonArray(workingPath);

  const workingByKey = new Map<string, number>();
  working.forEach((e, i) => workingByKey.set(entryKey(e), i));

  let replaced = 0;
  let added = 0;
  for (const e of entries) {
    const key = entryKey(e);
    const idx = workingByKey.get(key);
    if (idx !== undefined) {
      working[idx] = e;
      replaced++;
    } else {
      working.push(e);
      workingByKey.set(key, working.length - 1);
      added++;
    }
  }

  if (replaced === 0 && added === 0) return { replaced: 0, added: 0, path: workingPath };
  writeAtomic(workingPath, working);
  return { replaced, added, path: workingPath };
}

function writeAtomic(workingPath: string, combined: RegistryEntry[]): void {
  const tmpPath = `${workingPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(combined, null, 2), "utf-8");
  try {
    renameSync(tmpPath, workingPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export function knownEntryKeys(): Set<string> {
  const seedPath = resolve(process.cwd(), config.storage.seedRegistryPath);
  const workingPath = resolve(process.cwd(), config.storage.workingRegistryPath);
  const known = new Set<string>();
  for (const e of readJsonArray(seedPath)) known.add(entryKey(e));
  for (const e of readJsonArray(workingPath)) known.add(entryKey(e));
  return known;
}

export function knownCompanyNames(): Set<string> {
  const seedPath = resolve(process.cwd(), config.storage.seedRegistryPath);
  const workingPath = resolve(process.cwd(), config.storage.workingRegistryPath);
  const names = new Set<string>();
  for (const e of readJsonArray(seedPath)) names.add(kebabCase(e.name));
  for (const e of readJsonArray(workingPath)) names.add(kebabCase(e.name));
  return names;
}

export { entryKey, kebabCase };
