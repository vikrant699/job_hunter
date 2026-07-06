// src/discovery/json-writer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertRegistry, appendToRegistry, updateRegistryStrategy } from "./json-writer.js";
import type { RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema } from "../schemas.js";

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

test("appendToRegistry throws on corrupt JSON rather than silently treating it as empty", () => {
  const f = tmpFile();
  writeFileSync(f, "{not valid json", "utf8");
  assert.throws(() => appendToRegistry([E("custom", "a", "A")], f));
  // The corrupt file must be left untouched — no atomic overwrite happened.
  assert.equal(readFileSync(f, "utf8"), "{not valid json");
});

test("appendToRegistry throws when the file is valid JSON but fails the registry schema", () => {
  const f = tmpFile();
  writeFileSync(f, JSON.stringify([{ name: "Missing required fields" }]), "utf8");
  assert.throws(() => appendToRegistry([E("custom", "a", "A")], f));
});

test("updateRegistryStrategy patches only parsing_strategy, leaves other fields", () => {
  const f = tmpFile();
  upsertRegistry([{ ...E("custom", "spa-co", "Spa Co"), evidence: "seed note" }], f);
  const flipped = updateRegistryStrategy("custom", "spa-co", "Spa Co", "playwright-llm-scrape", f);
  assert.equal(flipped, true);
  const arr = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(f, "utf8")));
  assert.equal(arr[0]!.parsing_strategy, "playwright-llm-scrape");
  assert.equal(arr[0]!.evidence, "seed note"); // untouched
  // Second flip to the same value is a no-op.
  assert.equal(updateRegistryStrategy("custom", "spa-co", "Spa Co", "playwright-llm-scrape", f), false);
  // Unknown key does not write.
  assert.equal(updateRegistryStrategy("custom", "missing", "Missing", "playwright-llm-scrape", f), false);
});
