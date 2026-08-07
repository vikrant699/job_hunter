import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * src/index.ts must be able to run the Drive sync BEFORE the SQLite file is open,
 * because the pull replaces that file: on Windows the rename then fails with
 * EPERM, and on Linux it succeeds while the open handle keeps reading the file
 * that was replaced - a stale run that pushes its stale state back.
 *
 * db/db.ts opens the connection at module load, so the rule is structural: nothing
 * in index.ts's STATIC import graph may reach it. The run's body therefore lives in
 * runOnce.ts, reached by dynamic import after the sync.
 *
 * A comment cannot enforce that - one innocuous `import { postings } from
 * "./db/index.js"` at the top of index.ts would undo it silently, and the symptom
 * would be a platform-dependent failure inside a multi-hour run. So it is a test.
 */

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Static specifiers that actually execute the target module. `import type` is
 * erased before runtime and `await import(...)` is exactly the escape hatch
 * index.ts relies on, so both are excluded.
 *
 * `export ... from` counts: a re-export loads the target module just as an import
 * does, and src/db/index.ts is a pure barrel of them - so missing that form made
 * this guard pass while db.ts was in fact one hop away.
 */
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

// The other half of the contract: the module index.ts defers to must genuinely be
// the DB-backed half, or the split has quietly stopped meaning anything.
test("runOnce.ts is the module that owns the database half of the run", () => {
  const reachable = reachableFrom(resolve(srcDir, "runOnce.ts"));
  assert.ok(
    reachable.has(resolve(srcDir, "db", "db.ts")),
    "runOnce.ts is expected to reach db/db.ts — if it no longer does, the dynamic import in index.ts is pointless indirection",
  );
});

// db/sync.ts is imported by index.ts *before* the sync, so it must stay clear of
// db.ts too. It talks to db.ts through the one-bit openState.ts channel instead.
test("db/sync.ts does not itself open the database", () => {
  const reachable = reachableFrom(resolve(srcDir, "db", "sync.ts"));
  assert.ok(
    !reachable.has(resolve(srcDir, "db", "db.ts")),
    "db/sync.ts must not import db/db.ts — importing it is what opens the handle the pull is trying to replace",
  );
});
