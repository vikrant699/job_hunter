import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./fs.js";

test("writeFileAtomic writes content and leaves no temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-test-"));
  const p = join(dir, "out.json");
  writeFileAtomic(p, "hello");
  assert.equal(readFileSync(p, "utf-8"), "hello");
  assert.deepEqual(readdirSync(dir), ["out.json"]);
});

test("writeFileAtomic creates parent directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-test-"));
  const p = join(dir, "nested", "deep", "out.txt");
  writeFileAtomic(p, "x");
  assert.equal(existsSync(p), true);
});
