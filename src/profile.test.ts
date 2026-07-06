import { test } from "node:test";
import assert from "node:assert/strict";
import { profile, assertMatchThresholdAboveFloor } from "./profile.js";
import { SILENT_SCORE_FLOOR } from "./schemas.js";

test("profile has an id (defaults to 'default')", () => {
  assert.ok(typeof profile.id === "string" && profile.id.length > 0);
});

test("assertMatchThresholdAboveFloor throws when matchThreshold is at the silent floor", () => {
  assert.throws(
    () => assertMatchThresholdAboveFloor(SILENT_SCORE_FLOOR),
    /must be greater than/,
  );
});

test("assertMatchThresholdAboveFloor throws when matchThreshold is below the silent floor", () => {
  assert.throws(
    () => assertMatchThresholdAboveFloor(SILENT_SCORE_FLOOR - 0.1),
    /must be greater than/,
  );
});

test("assertMatchThresholdAboveFloor does not throw when matchThreshold is above the silent floor", () => {
  assert.doesNotThrow(() => assertMatchThresholdAboveFloor(SILENT_SCORE_FLOOR + 0.01));
});
