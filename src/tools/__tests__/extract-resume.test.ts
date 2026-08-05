import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeResumeText } from "../extract-resume.js";

test("normalizeResumeText collapses blank-line runs and trims whitespace", () => {
  const out = normalizeResumeText("  Hello   world \n\n\n\nFoo\t\tbar\n\n");
  assert.equal(out, "Hello world\n\nFoo bar\n");
});

test("normalizeResumeText is idempotent", () => {
  const once = normalizeResumeText("a\n\n\nb\r\n\r\n");
  assert.equal(normalizeResumeText(once), once);
});
