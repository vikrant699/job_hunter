// src/discovery/json-writer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertRegistry, appendToRegistry } from "./json-writer.js";
import type { RegistryEntry } from "../types.js";
import { RegistryEntrySchema } from "../types.js";

function tmpFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), "reg-")), "companies.json");
  writeFileSync(f, "[]", "utf8");
  return f;
}
const E = (source: RegistryEntry["source"], slug: string, name: string): RegistryEntry => ({
  name, careers_url: "https://x/" + slug, source,
  source_slug: slug, parsing_strategy: "llm-scrape",
});

test("upsertRegistry adds entries and writes them sorted by source then slug", () => {
  const f = tmpFile();
  upsertRegistry([E("custom", "zeta", "Zeta"), E("ashby", "alpha", "Alpha")], f);
  const arr = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(f, "utf8")));
  assert.equal(arr.length, 2);
  assert.equal(arr[0]!.source, "ashby"); // ashby < custom
  assert.equal(arr[1]!.source, "custom");
});

test("upsertRegistry replaces an existing key idempotently", () => {
  const f = tmpFile();
  upsertRegistry([E("ashby", "alpha", "Alpha")], f);
  const r = upsertRegistry([{ ...E("ashby", "alpha", "Alpha"), careers_url: "https://new" }], f);
  assert.equal(r.replaced, 1);
  assert.equal(r.added, 0);
  const arr = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(f, "utf8")));
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.careers_url, "https://new");
});

test("appendToRegistry skips duplicates by key", () => {
  const f = tmpFile();
  appendToRegistry([E("custom", "a", "A")], f);
  const r = appendToRegistry([E("custom", "a", "A"), E("custom", "b", "B")], f);
  assert.equal(r.written, 1);
  assert.equal(r.skippedDuplicates, 1);
});
