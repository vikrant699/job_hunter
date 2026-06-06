import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSemaphore } from "./semaphore.js";

test("makeSemaphore caps concurrency at the live limit", async () => {
  let limit = 2, active = 0, peak = 0;
  const acquire = makeSemaphore(() => limit);
  const task = async () => {
    const release = await acquire();
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--; release();
  };
  await Promise.all(Array.from({ length: 6 }, task));
  assert.equal(peak, 2);
});
