import { test } from "node:test";
import assert from "node:assert/strict";
import { isJunkJd } from "../junkJd.js";

test("isJunkJd flags known vendor placeholders", () => {
  assert.equal(isJunkJd("Please enter job description"), true);
  assert.equal(isJunkJd("Please update the Job Description"), true);
  assert.equal(isJunkJd("  please enter job description.  "), true);
  assert.equal(isJunkJd("Attached"), true);
  assert.equal(isJunkJd("lorem ipsum dolor"), true);
  assert.equal(isJunkJd("Sample Data"), true);
});

test("isJunkJd flags letterless junk (dots-only JDs)", () => {
  assert.equal(isJunkJd("....."), true);
  assert.equal(isJunkJd("- - -"), true);
});

test("isJunkJd keeps real JDs, however short, and empty strings", () => {
  assert.equal(isJunkJd(""), false); // empty stays on the existing no-jd path
  assert.equal(isJunkJd("CSA"), false); // thin-but-real (hrone) is a source problem, not junk
  assert.equal(isJunkJd("Java, AWS, MongoDB, spring"), false);
  assert.equal(isJunkJd("We are hiring a senior engineer to build our payments stack."), false);
});
