import { test } from "node:test";
import assert from "node:assert/strict";
import { entryToRow, rowToEntry, REGISTRY_COLUMNS } from "../sheetCodec.js";
import type { RegistryEntry } from "../../schemas.js";

const fullEntry: RegistryEntry = {
  name: "Atlan",
  careers_url: "https://atlan.com/careers/",
  source: "ashby",
  source_slug: "atlan",
  parsing_strategy: "ats-api",
  status: "active",
  reason: "why not",
  discovered_via: "seed",
  discovered_at: "2026-01-01T00:00:00.000Z",
  evidence: "ashby (5 jobs)",
  tenant_url: "https://x.example.com",
  api_meta: { orgGuid: "abc-123" },
  category: "DevTools-Infra",
  employer_type: "product",
};

const minimalEntry: RegistryEntry = {
  name: "Clueso",
  careers_url: "https://jobs.ashbyhq.com/clueso",
  source: "ashby",
  parsing_strategy: "ats-api",
};

test("entryToRow serializes every column in REGISTRY_COLUMNS order", () => {
  const row = entryToRow(fullEntry);
  assert.equal(row.length, REGISTRY_COLUMNS.length);
  assert.equal(row[0], "Atlan");
  assert.equal(row[REGISTRY_COLUMNS.indexOf("api_meta")], JSON.stringify({ orgGuid: "abc-123" }));
});

test("entryToRow leaves absent optional fields as empty cells", () => {
  const row = entryToRow(minimalEntry);
  assert.equal(row[REGISTRY_COLUMNS.indexOf("status")], "");
  assert.equal(row[REGISTRY_COLUMNS.indexOf("api_meta")], "");
});

test("round-trip: full entry survives entryToRow -> rowToEntry", () => {
  const result = rowToEntry(entryToRow(fullEntry));
  assert.ok(result.ok);
  assert.deepEqual(result.entry, fullEntry);
});

test("round-trip: minimal entry survives with optionals absent", () => {
  const result = rowToEntry(entryToRow(minimalEntry));
  assert.ok(result.ok);
  assert.deepEqual(result.entry, minimalEntry);
});

test("rowToEntry pads short rows (trailing empty cells trimmed by Sheets)", () => {
  const result = rowToEntry(["Clueso", "https://jobs.ashbyhq.com/clueso", "ashby", "", "ats-api"]);
  assert.ok(result.ok);
  assert.equal(result.entry.name, "Clueso");
});

test("rowToEntry rejects an invalid source with issues, not a throw", () => {
  const result = rowToEntry(["X", "https://x.com/careers", "not-a-provider", "", "ats-api"]);
  assert.ok(!result.ok);
  assert.match(result.issues, /source/);
});

test("rowToEntry rejects malformed api_meta JSON with issues", () => {
  const row = entryToRow(minimalEntry);
  row[REGISTRY_COLUMNS.indexOf("api_meta")] = "{not json";
  const result = rowToEntry(row);
  assert.ok(!result.ok);
  assert.match(result.issues, /api_meta/);
});

test("rowToEntry rejects api_meta with non-string values", () => {
  const row = entryToRow(minimalEntry);
  row[REGISTRY_COLUMNS.indexOf("api_meta")] = JSON.stringify({ n: 5 });
  const result = rowToEntry(row);
  assert.ok(!result.ok);
  assert.match(result.issues, /api_meta/);
});
