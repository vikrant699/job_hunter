import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryToRow, REGISTRY_COLUMNS } from "../registry/sheet-codec.js";
import type { RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema } from "../schemas.js";
import { appendToRegistry, updateRegistryStrategy, type RegistryWriterDeps } from "./registry-writer.js";

function tmpCache(seed: RegistryEntry[] = []): string {
  const f = join(mkdtempSync(join(tmpdir(), "reg-writer-")), "registry-cache.json");
  writeFileSync(f, JSON.stringify(seed, null, 2), "utf-8");
  return f;
}

const E = (source: RegistryEntry["source"], slug: string, name: string): RegistryEntry => ({
  name, careers_url: "https://x/" + slug, source,
  source_slug: slug, parsing_strategy: "llm-scrape",
});

interface Harness {
  deps: RegistryWriterDeps;
  appended: Array<{ tab: string; rows: string[][] }>;
  updatedRanges: Array<{ rangeA1: string; rows: string[][] }>;
  sheetRows: string[][];
}

function harness(existing: RegistryEntry[], cachePath: string): Harness {
  const appended: Harness["appended"] = [];
  const updatedRanges: Harness["updatedRanges"] = [];
  const sheetRows = [[...REGISTRY_COLUMNS], ...existing.map(entryToRow)];
  const deps: RegistryWriterDeps = {
    readTab: async () => sheetRows,
    appendRows: async (profileId: string, tab: string, rows: string[][]) => {
      appended.push({ tab, rows });
    },
    updateRange: async (profileId: string, rangeA1: string, rows: string[][]) => {
      updatedRanges.push({ rangeA1, rows });
    },
    cachePath,
  };
  return { deps, appended, updatedRanges, sheetRows };
}

test("appendToRegistry appends only new entries to the tab and mirrors them into the cache", async () => {
  const tag = `rw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const existing = [E("custom", `${tag}-a`, `A-${tag}`)];
  const cachePath = tmpCache(existing);
  const { deps, appended } = harness(existing, cachePath);

  const r = await appendToRegistry(
    [E("custom", `${tag}-a`, `A-${tag}`), E("ashby", `${tag}-b`, `B-${tag}`)],
    "default",
    deps,
  );

  assert.equal(r.written, 1);
  assert.equal(r.skippedDuplicates, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.rows.length, 1);
  assert.equal(appended[0]?.rows[0]?.[0], `B-${tag}`);

  const cached = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(cachePath, "utf-8")));
  assert.equal(cached.length, 2);
  assert.ok(cached.some((e) => e.name === `B-${tag}`));
});

test("appendToRegistry is a no-op (no append call) when everything is a duplicate", async () => {
  const tag = `rw-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const existing = [E("custom", `${tag}-a`, `A-${tag}`)];
  const cachePath = tmpCache(existing);
  const { deps, appended } = harness(existing, cachePath);

  const r = await appendToRegistry([E("custom", `${tag}-a`, `A-${tag}`)], "default", deps);

  assert.equal(r.written, 0);
  assert.equal(r.skippedDuplicates, 1);
  assert.equal(appended.length, 0);
});

test("updateRegistryStrategy patches the parsing_strategy cell of the matching row", async () => {
  const tag = `rw-strat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const existing = [E("custom", `${tag}-spa`, `Spa-${tag}`)];
  const cachePath = tmpCache(existing);
  const { deps, updatedRanges } = harness(existing, cachePath);

  const flipped = await updateRegistryStrategy(
    "custom", `${tag}-spa`, `Spa-${tag}`, "playwright-llm-scrape", "default", deps,
  );

  assert.equal(flipped, true);
  assert.equal(updatedRanges.length, 1);
  // Row 1 is the header, so the first (only) data row is sheet row 2.
  assert.match(updatedRanges[0]?.rangeA1 ?? "", /!E2$/);
  assert.equal(updatedRanges[0]?.rows[0]?.[0], "playwright-llm-scrape");

  const cached = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(cachePath, "utf-8")));
  assert.equal(cached[0]?.parsing_strategy, "playwright-llm-scrape");
});

test("updateRegistryStrategy returns false and writes nothing when no row matches the key", async () => {
  const tag = `rw-nomatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cachePath = tmpCache([]);
  const { deps, updatedRanges } = harness([], cachePath);

  const flipped = await updateRegistryStrategy(
    "custom", `${tag}-missing`, `Missing-${tag}`, "playwright-llm-scrape", "default", deps,
  );

  assert.equal(flipped, false);
  assert.equal(updatedRanges.length, 0);
});

test("appendToRegistry throws when the sheet is unreachable (no silent cache-only write)", async () => {
  const tag = `rw-err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cachePath = tmpCache([]);
  const deps: RegistryWriterDeps = {
    readTab: async () => { throw new Error("network down"); },
    appendRows: async () => { throw new Error("should not be called"); },
    updateRange: async () => { throw new Error("should not be called"); },
    cachePath,
  };

  await assert.rejects(() => appendToRegistry([E("custom", `${tag}-a`, `A-${tag}`)], "default", deps));
});
