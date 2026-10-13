import { writeFileAtomic } from "./fs.js";
import type { RegistryEntry } from "../schemas.js";

export function writeAtomic(path: string, entries: RegistryEntry[]): void {
  writeFileAtomic(path, JSON.stringify(entries, null, 2));
}
