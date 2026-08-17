import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  normalizeResumeText,
  isResumeTextStale,
  ensureResumeText,
  resolveCliBaseDir,
} from "../extractResume.js";

function mkResumeDir(): string {
  return mkdtempSync(join(tmpdir(), "resume-test-"));
}

/** Set a file's mtime to a fixed offset (seconds) from a base epoch. */
function setMtime(path: string, offsetSec: number): void {
  const t = 1_700_000_000 + offsetSec;
  utimesSync(path, t, t);
}

test("normalizeResumeText collapses blank-line runs and trims whitespace", () => {
  const out = normalizeResumeText("  Hello   world \n\n\n\nFoo\t\tbar\n\n");
  assert.equal(out, "Hello world\n\nFoo bar\n");
});

test("normalizeResumeText is idempotent", () => {
  const once = normalizeResumeText("a\n\n\nb\r\n\r\n");
  assert.equal(normalizeResumeText(once), once);
});

test("isResumeTextStale: missing resume.txt is stale", () => {
  const dir = mkResumeDir();
  writeFileSync(join(dir, "resume.pdf"), "not a real pdf");
  assert.equal(isResumeTextStale(dir), true);
});

test("isResumeTextStale: resume.txt without a pdf is not stale (cached text stands alone)", () => {
  const dir = mkResumeDir();
  writeFileSync(join(dir, "resume.txt"), "cached text\n");
  assert.equal(isResumeTextStale(dir), false);
});

test("isResumeTextStale: pdf newer than txt is stale", () => {
  const dir = mkResumeDir();
  writeFileSync(join(dir, "resume.txt"), "cached text\n");
  writeFileSync(join(dir, "resume.pdf"), "not a real pdf");
  setMtime(join(dir, "resume.txt"), 0);
  setMtime(join(dir, "resume.pdf"), 60);
  assert.equal(isResumeTextStale(dir), true);
});

test("isResumeTextStale: txt newer than pdf is not stale", () => {
  const dir = mkResumeDir();
  writeFileSync(join(dir, "resume.txt"), "cached text\n");
  writeFileSync(join(dir, "resume.pdf"), "not a real pdf");
  setMtime(join(dir, "resume.pdf"), 0);
  setMtime(join(dir, "resume.txt"), 60);
  assert.equal(isResumeTextStale(dir), false);
});

test("ensureResumeText returns the cached txt when it is fresher than the pdf", async () => {
  const dir = mkResumeDir();
  // Garbage pdf bytes: a wrong attempt to parse it fails with an unpdf error instead of returning cached text.
  writeFileSync(join(dir, "resume.pdf"), "not a real pdf");
  writeFileSync(join(dir, "resume.txt"), "cached text\n");
  setMtime(join(dir, "resume.pdf"), 0);
  setMtime(join(dir, "resume.txt"), 60);
  assert.equal(await ensureResumeText(dir), "cached text\n");
});

test("ensureResumeText re-extracts (attempts the PDF parse) when the pdf is newer than the txt", async () => {
  const dir = mkResumeDir();
  writeFileSync(join(dir, "resume.txt"), "stale cached text\n");
  writeFileSync(join(dir, "resume.pdf"), "not a real pdf");
  setMtime(join(dir, "resume.txt"), 0);
  setMtime(join(dir, "resume.pdf"), 60);
  // The garbage pdf makes the parse throw - proof the extract path was taken, not the stale cache.
  await assert.rejects(ensureResumeText(dir));
});

test("resolveCliBaseDir: --profile <name> targets that profile's config dir", () => {
  const dir = resolveCliBaseDir(["node", "extractResume.ts", "--profile", "vikrant"]);
  assert.ok(dir.endsWith(join("config", "profiles", "vikrant")), dir);
});

test("resolveCliBaseDir: no --profile falls back to the default config dir", () => {
  const dir = resolveCliBaseDir(["node", "extractResume.ts"]);
  assert.ok(dir.endsWith(`${sep}config`), dir);
});

test("resolveCliBaseDir: --profile followed by another flag falls back to the default dir", () => {
  const dir = resolveCliBaseDir(["node", "extractResume.ts", "--profile", "--force"]);
  assert.ok(dir.endsWith(`${sep}config`), dir);
});
