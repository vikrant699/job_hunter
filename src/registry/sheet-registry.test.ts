import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectAllCompanies } from "../db/index.js";
import { REGISTRY_COLUMNS, entryToRow } from "./sheet-codec.js";
import type { RegistryEntry } from "../schemas.js";
import { RegistryEntrySchema } from "../schemas.js";
import { syncRegistryFromSheet } from "./sheet-registry.js";

function tmpCache(): string {
  return join(mkdtempSync(join(tmpdir(), "reg-cache-")), "registry-cache.json");
}

const E = (source: RegistryEntry["source"], slug: string, name: string): RegistryEntry => ({
  name,
  careers_url: "https://x/" + slug,
  source,
  source_slug: slug,
  parsing_strategy: "llm-scrape",
});

/** Builds the sheet rows (header + entry rows) exactly as readTab would return them. */
function sheetRows(entries: RegistryEntry[]): string[][] {
  return [[...REGISTRY_COLUMNS], ...entries.map(entryToRow)];
}

test("syncRegistryFromSheet: valid sheet syncs, prunes, and snapshots to the cache", async () => {
  const cachePath = tmpCache();
  const tag = `sheetreg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entries = [E("custom", `${tag}-a`, `A-${tag}`), E("ashby", `${tag}-b`, `B-${tag}`)];

  const result = await syncRegistryFromSheet("default", {
    readTab: async () => sheetRows(entries),
    cachePath,
  });

  assert.equal(result.source, "sheet");
  assert.equal(result.synced, 2);
  assert.equal(result.invalidRows.length, 0);
  assert.equal(result.pruned, 0);

  const all = selectAllCompanies();
  assert.ok(all.some((c) => c.slug === `${tag}-a` && c.provider === "custom"));
  assert.ok(all.some((c) => c.slug === `${tag}-b` && c.provider === "ashby"));

  assert.ok(existsSync(cachePath));
  const cached = RegistryEntrySchema.array().parse(JSON.parse(readFileSync(cachePath, "utf-8")));
  assert.equal(cached.length, 2);
});

test("syncRegistryFromSheet: an invalid row is quarantined, valid rows still upsert, prune is disabled", async () => {
  const cachePath = tmpCache();
  const tag = `sheetreg-bad-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const good = E("custom", `${tag}-good`, `Good-${tag}`);
  const rows = [
    [...REGISTRY_COLUMNS],
    entryToRow(good),
    // Invalid: source is not a known provider.
    ["Bad Co", "https://bad.example/careers", "not-a-real-provider", "", "ats-api", "", "", "", "", "", "", "", "", ""],
  ];

  const result = await syncRegistryFromSheet("default", {
    readTab: async () => rows,
    cachePath,
  });

  assert.equal(result.source, "sheet");
  assert.equal(result.synced, 1);
  assert.equal(result.pruned, 0); // prune disabled by the bad row
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.invalidRows[0]?.rowIndex, 3); // header=row1, good=row2, bad=row3
  assert.match(result.invalidRows[0]?.issues ?? "", /source/);

  const all = selectAllCompanies();
  assert.ok(all.some((c) => c.slug === `${tag}-good`));

  // The cache snapshot is skipped too: the offline fallback trusts the cache
  // with prune enabled, so a partial snapshot would prune quarantined-row
  // companies on a later offline run.
  assert.ok(!existsSync(cachePath), "cache must NOT be written when rows were quarantined");
});

test("syncRegistryFromSheet: a zero-row sheet read never prunes and never overwrites the cache", async () => {
  const tag = `sheetreg-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const survivor = E("custom", `${tag}-keep`, `Keep-${tag}`);
  await syncRegistryFromSheet("default", {
    readTab: async () => sheetRows([survivor]),
    cachePath: tmpCache(),
  });

  // Header-only tab (e.g. data rows cleared, or the API returned no values):
  // must be treated as a suspect read, not as "delete everything".
  const emptyCachePath = tmpCache();
  const result = await syncRegistryFromSheet("default", {
    readTab: async () => [[...REGISTRY_COLUMNS]],
    cachePath: emptyCachePath,
  });

  assert.equal(result.source, "sheet");
  assert.equal(result.synced, 0);
  assert.equal(result.pruned, 0);
  assert.ok(selectAllCompanies().some((c) => c.slug === `${tag}-keep`), "existing companies must survive");
  assert.ok(!existsSync(emptyCachePath), "cache must NOT be overwritten by an empty read");
});

test("syncRegistryFromSheet: sheet read throws -> falls back to the cache with source 'cache'", async () => {
  const cachePath = tmpCache();
  const tag = `sheetreg-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cached = [E("custom", `${tag}-c`, `C-${tag}`)];
  writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf-8");

  const result = await syncRegistryFromSheet("default", {
    readTab: async () => { throw new Error("network down"); },
    cachePath,
  });

  assert.equal(result.source, "cache");
  assert.equal(result.synced, 1);
  assert.equal(result.invalidRows.length, 0);

  const all = selectAllCompanies();
  assert.ok(all.some((c) => c.slug === `${tag}-c`));
});

test("syncRegistryFromSheet: sheet throws AND cache missing -> throws an actionable error", async () => {
  const cachePath = tmpCache(); // directory exists, file does not

  await assert.rejects(
    () =>
      syncRegistryFromSheet("default", {
        readTab: async () => { throw new Error("network down"); },
        cachePath,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /bootstrap|GOOGLE_/i);
      return true;
    },
  );
});
