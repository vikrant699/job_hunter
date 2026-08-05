// src/ats/browserFetch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientEvalError, runWithEvalRetry, MAX_EVAL_ATTEMPTS, HEAVY_ASSET_RE } from "../browserFetch.js";

test("isTransientEvalError matches the three observed transient shapes, case-insensitively", () => {
  assert.equal(isTransientEvalError(new Error("Execution context was destroyed, most likely because of a navigation")), true);
  assert.equal(isTransientEvalError(new Error("Failed to fetch")), true);
  assert.equal(isTransientEvalError(new Error("Target closed")), true);
  assert.equal(isTransientEvalError(new Error("HTTP 403")), false);
});

test("runWithEvalRetry succeeds after transient failures and settles between attempts", async () => {
  let calls = 0;
  let settles = 0;
  const result = await runWithEvalRetry(
    async () => {
      calls++;
      if (calls <= 2) throw new Error("failed to fetch");
      return "ok";
    },
    async () => {
      settles++;
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(settles, 2);
});

test("runWithEvalRetry gives up after MAX_EVAL_ATTEMPTS", async () => {
  let calls = 0;
  await assert.rejects(
    runWithEvalRetry(async () => {
      calls++;
      throw new Error("target closed");
    }, async () => {}),
    /target closed/,
  );
  assert.equal(calls, MAX_EVAL_ATTEMPTS);
});

test("runWithEvalRetry rethrows non-transient errors immediately", async () => {
  let calls = 0;
  await assert.rejects(runWithEvalRetry(async () => {
    calls++;
    throw new Error("HTTP 500");
  }, async () => {}), /HTTP 500/);
  assert.equal(calls, 1);
});

test("HEAVY_ASSET_RE blocks assets, passes API paths", () => {
  assert.equal(HEAVY_ASSET_RE.test("https://x.com/app.css?v=1"), true);
  assert.equal(HEAVY_ASSET_RE.test("https://x.com/font.woff2"), true);
  assert.equal(HEAVY_ASSET_RE.test("https://x.com/api/jobs"), false);
});
