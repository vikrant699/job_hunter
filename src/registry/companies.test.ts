// src/registry/companies.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectAllCompanies } from "../db/index.js";
import { readRegistryFile, syncEntries } from "./companies.js";
import type { RegistryEntry } from "../schemas.js";

function tmpFile(contents: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "companies-")), "registry.json");
  writeFileSync(f, contents, "utf-8");
  return f;
}

const E = (source: RegistryEntry["source"], slug: string, name: string): RegistryEntry => ({
  name, careers_url: "https://x/" + slug, source,
  source_slug: slug, parsing_strategy: "llm-scrape",
});

test("readRegistryFile returns [] for a missing file", () => {
  assert.deepEqual(readRegistryFile(join(mkdtempSync(join(tmpdir(), "companies-")), "missing.json")), []);
});

test("readRegistryFile throws on invalid JSON", () => {
  const f = tmpFile("{not json");
  assert.throws(() => readRegistryFile(f));
});

test("readRegistryFile throws when entries fail schema validation", () => {
  const f = tmpFile(JSON.stringify([{ name: "Missing required fields" }]));
  assert.throws(() => readRegistryFile(f));
});

test("readRegistryFile parses a valid registry array", () => {
  const f = tmpFile(JSON.stringify([E("custom", "a", "A")]));
  const entries = readRegistryFile(f);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, "A");
});

test("syncEntries upserts entries into the companies table and prunes orphans when prune:true", () => {
  const tag = `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  syncEntries([E("custom", `${tag}-keep`, `Keep-${tag}`), E("custom", `${tag}-gone`, `Gone-${tag}`)], { prune: true });
  syncEntries([E("custom", `${tag}-keep`, `Keep-${tag}`)], { prune: true });

  const all = selectAllCompanies();
  assert.ok(all.some((c) => c.slug === `${tag}-keep`));
  assert.ok(!all.some((c) => c.slug === `${tag}-gone`), "orphaned entry should have been pruned");
});

test("a new registry entry with no explicit status defaults to active", () => {
  const slug = `default-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  syncEntries([E("custom", slug, `Default Status Co ${slug}`)], { prune: false });

  const row = selectAllCompanies().find((c) => c.slug === slug);
  assert.equal(row?.status, "active");
});

test("syncEntries does not prune when prune:false", () => {
  const tag = `sync-noprune-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  syncEntries([E("custom", `${tag}-keep`, `Keep-${tag}`), E("custom", `${tag}-stays`, `Stays-${tag}`)], { prune: true });
  const result = syncEntries([E("custom", `${tag}-keep`, `Keep-${tag}`)], { prune: false });

  assert.equal(result.pruned, 0);
  const all = selectAllCompanies();
  assert.ok(all.some((c) => c.slug === `${tag}-stays`), "entry must survive when prune is disabled");
});
