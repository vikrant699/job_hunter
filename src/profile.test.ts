import { test } from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.js";

test("profile has an id (defaults to 'default')", () => {
  assert.ok(typeof profile.id === "string" && profile.id.length > 0);
});
