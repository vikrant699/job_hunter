import { test } from "node:test";
import assert from "node:assert/strict";
import { compareState } from "../sync.js";

const NOW = 1_770_000_000_000;

test("compareState reports in-sync when both sides match", () => {
  assert.equal(compareState(NOW, NOW), "in-sync");
});

// Two machines never agree to the millisecond; a few seconds of drift must not
// read as "someone else pushed" and trigger a pointless pull.
test("compareState tolerates small clock skew in either direction", () => {
  assert.equal(compareState(NOW + 4_000, NOW), "in-sync");
  assert.equal(compareState(NOW - 4_000, NOW), "in-sync");
});

test("compareState detects a genuinely newer remote", () => {
  assert.equal(compareState(NOW, NOW + 60_000), "remote-newer");
});

test("compareState detects a genuinely newer local", () => {
  assert.equal(compareState(NOW + 60_000, NOW), "local-newer");
});

test("compareState reports no-remote on a first-ever push", () => {
  assert.equal(compareState(NOW, null), "no-remote");
});

test("compareState reports no-local on a fresh machine", () => {
  assert.equal(compareState(null, NOW), "no-local");
});

test("compareState reports no-local when neither side exists", () => {
  assert.equal(compareState(null, null), "no-local");
});

// The boundary matters: just past tolerance must flip the verdict, because this
// is what decides whether a run pulls before touching the DB.
test("compareState flips exactly outside the skew tolerance", () => {
  assert.equal(compareState(NOW, NOW + 5_000), "in-sync");
  assert.equal(compareState(NOW, NOW + 5_001), "remote-newer");
  assert.equal(compareState(NOW + 5_001, NOW), "local-newer");
});
