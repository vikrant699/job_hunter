import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// index.ts must run the Drive sync before db/db.ts opens the SQLite file (the pull replaces that file, and an open handle
// means EPERM on Windows or a stale read on Linux). db.ts opens on module load, so nothing in index.ts's static import
// graph may reach it; the run body lives in runOnce.ts, reached by dynamic import after the sync. A comment can't enforce
// that, so this test does.

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Static specifiers that actually execute the target module; `import type` and dynamic `import()` are excluded, but `export ... from` counts since a re-export loads the module too. */
function staticImportsOf(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const specs: string[] = [];
  const re = /^(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(re)) {
    const spec = match[1];
    if (spec !== undefined && spec.startsWith(".")) specs.push(spec);
  }
  return specs;
}

/** Resolve a TS-style "./x.js" specifier back to the .ts file on disk. */
function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` through executing imports, plus the path there. */
function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) break;
    const trail = seen.get(file) ?? [file];
    for (const spec of staticImportsOf(file)) {
      const target = resolveSpec(file, spec);
      if (target === null || seen.has(target)) continue;
      seen.set(target, [...trail, target]);
      queue.push(target);
    }
  }
  return seen;
}

test("index.ts does not open the database through its static imports", () => {
  const reachable = reachableFrom(resolve(srcDir, "index.ts"));
  const dbModule = resolve(srcDir, "db", "db.ts");
  const trail = reachable.get(dbModule);

  assert.equal(
    trail,
    undefined,
    trail === undefined
      ? ""
      : `src/db/db.ts opens the SQLite file at import, so it must not be statically ` +
          `reachable from index.ts — the Drive pull has to run first. Import chain:\n  ` +
          trail.map((f) => relative(srcDir, f)).join("\n  → ") +
          `\n\nMove whatever needs the DB into runOnce.ts (dynamically imported after syncBeforeRun).`,
  );
});

// The other half of the contract: index.ts's dynamic-import target must genuinely be the DB-backed half.
test("runOnce.ts is the module that owns the database half of the run", () => {
  const reachable = reachableFrom(resolve(srcDir, "runOnce.ts"));
  assert.ok(
    reachable.has(resolve(srcDir, "db", "db.ts")),
    "runOnce.ts is expected to reach db/db.ts — if it no longer does, the dynamic import in index.ts is pointless indirection",
  );
});

// db/sync.ts is imported before the sync runs, so it must stay clear of db.ts too (it uses openState.ts instead).
test("db/sync.ts does not itself open the database", () => {
  const reachable = reachableFrom(resolve(srcDir, "db", "sync.ts"));
  assert.ok(
    !reachable.has(resolve(srcDir, "db", "db.ts")),
    "db/sync.ts must not import db/db.ts — importing it is what opens the handle the pull is trying to replace",
  );
});
