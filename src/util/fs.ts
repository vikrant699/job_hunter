import { writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
