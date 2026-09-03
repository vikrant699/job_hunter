import { writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically overwrite `path` (write temp + rename; parent dirs created) so a crash mid-write can never leave a truncated file. */
export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
