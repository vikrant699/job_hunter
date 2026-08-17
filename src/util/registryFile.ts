import { writeFileAtomic } from "./fs.js";
import type { RegistryEntry } from "../schemas.js";

/** Atomically overwrites `path` with `entries` (temp file + rename), so a crash mid-write never leaves a half-written cache file. */
export function writeAtomic(path: string, entries: RegistryEntry[]): void {
  writeFileAtomic(path, JSON.stringify(entries, null, 2));
}
