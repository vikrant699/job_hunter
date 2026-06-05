// src/registry/companies.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

test("config exposes a single registryPath and not the old split keys", () => {
  assert.equal(config.storage.registryPath, "config/companies.json");
  assert.equal((config.storage as Record<string, unknown>).seedRegistryPath, undefined);
  assert.equal((config.storage as Record<string, unknown>).workingRegistryPath, undefined);
});

test("the committed registry parses as an array of entries with required fields", () => {
  const path = resolve(process.cwd(), config.storage.registryPath);
  const arr = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(arr) && arr.length > 0);
  for (const e of arr.slice(0, 50)) {
    assert.equal(typeof e.name, "string");
    assert.equal(typeof e.careers_url, "string");
    assert.equal(typeof e.source, "string");
    assert.equal(typeof e.parsing_strategy, "string");
  }
});
