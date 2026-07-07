import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import type { RegistryEntry } from "../schemas.js";

/**
 * Atomically overwrite `path` with `entries` (write to a temp file, then
 * rename). Used by the sheet-backed registry writers (src/discovery/
 * registry-writer.ts, src/registry/sheet-registry.ts) for their
 * data/registry-cache.json snapshot writes — a crash mid-write must never
 * leave a half-written cache file behind.
 */
export function writeAtomic(path: string, entries: RegistryEntry[]): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
