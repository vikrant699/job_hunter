import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryEntry } from "../../schemas.js";
import { RegistryEntrySchema } from "../../schemas.js";
import { writeAtomic } from "../registry-file.js";

const E = (name: string): RegistryEntry => ({
  name, careers_url: `https://x/${name}`, source: "custom", parsing_strategy: "llm-scrape",
});

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "registry-file-")), "registry.json");
}

test("writeAtomic writes a JSON array that round-trips through JSON.parse", () => {
  const f = tmpPath();
  writeAtomic(f, [E("A"), E("B")]);
  const parsed: unknown = JSON.parse(readFileSync(f, "utf-8"));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

test("writeAtomic leaves no leftover .tmp-<pid> file after a successful write", () => {
  const f = tmpPath();
  writeAtomic(f, [E("A")]);
  assert.ok(existsSync(f));
  assert.ok(!existsSync(`${f}.tmp-${process.pid}`));
});

test("writeAtomic overwrites an existing file completely (no merge)", () => {
  const f = tmpPath();
  writeFileSync(f, JSON.stringify([E("Old")]), "utf-8");
  writeAtomic(f, [E("New")]);
  const parsed = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(f, "utf-8")));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.name, "New");
});
