import { writeFileAtomic } from "./fs.js";
import type { RegistryEntry } from "../schemas.js";

/**
 * Atomically overwrite `path` with `entries` (write to a temp file, then
 * rename). Used by the sheet-backed registry writers (src/registry/
 * sheetWriter.ts, src/registry/sheetRegistry.ts) for their
 * data/registry-cache.json snapshot writes — a crash mid-write must never
 * leave a half-written cache file behind.
 *
 * Thin typed wrapper over util/fs writeFileAtomic (JSON-array serialization).
 */
export function writeAtomic(path: string, entries: RegistryEntry[]): void {
  writeFileAtomic(path, JSON.stringify(entries, null, 2));
}
