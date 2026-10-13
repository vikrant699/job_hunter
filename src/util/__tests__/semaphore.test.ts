import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSemaphore } from "../semaphore.js";

test("makeSemaphore release is idempotent (double-release does not over-grant)", async () => {
  const acquire = makeSemaphore(() => 1);
  const r1 = await acquire();
  r1(); r1();
  const r2 = await acquire();
  let thirdGranted = false;
  void acquire().then((rel) => { thirdGranted = true; rel(); });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(thirdGranted, false);
  r2();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(thirdGranted, true);
});

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
