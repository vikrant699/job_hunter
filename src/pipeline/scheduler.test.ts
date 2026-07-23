import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFetchError } from "./scheduler.js";

test("classifyFetchError tags the common ATS failure modes", () => {
  assert.equal(classifyFetchError("AbortError: This operation was aborted"), "timeout");
  assert.equal(classifyFetchError("Error: lever 404"), "404");
  assert.equal(classifyFetchError("Error: gohire HTTP 429: User limit exceeded"), "rate-limited");
  assert.equal(classifyFetchError("Error: workday HTTP 520: <!DOCTYPE html>"), "5xx");
  assert.equal(classifyFetchError("Error: workday list response failed schema for logitech"), "schema");
  assert.equal(classifyFetchError("TypeError: fetch failed"), "network");
  assert.equal(classifyFetchError("Error: workday tenant URL missing site segment"), "config");
  assert.equal(classifyFetchError("Error: something weird happened"), "other");
});
