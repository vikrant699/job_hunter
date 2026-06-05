import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCandidateContext } from "./gate.js";

test("resolveCandidateContext prefers override, then resumeText, then summary", () => {
  assert.equal(resolveCandidateContext("X", { resumeText: "R", summary: "S" }), "X");
  assert.equal(resolveCandidateContext(undefined, { resumeText: "R", summary: "S" }), "R");
  assert.equal(resolveCandidateContext(undefined, { summary: "S" }), "S");
});
