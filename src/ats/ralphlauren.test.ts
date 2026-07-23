import { test } from "node:test";
import assert from "node:assert/strict";
import { indiaCityFromLatlon } from "./ralphlauren.js";

test("indiaCityFromLatlon maps Bangalore coords to a city string", () => {
  assert.equal(indiaCityFromLatlon("12.9716,77.5946"), "Bengaluru, India");
});

test("indiaCityFromLatlon returns 'India' for other in-box coords", () => {
  assert.equal(indiaCityFromLatlon("28.6139,77.2090"), "India"); // Delhi
});

test("indiaCityFromLatlon rejects foreign coords", () => {
  assert.equal(indiaCityFromLatlon("40.7128,-74.0060"), null); // NYC
  assert.equal(indiaCityFromLatlon("51.5099,-0.1413"), null); // London
});

test("indiaCityFromLatlon returns null for empty / ungeocoded", () => {
  assert.equal(indiaCityFromLatlon(""), null);
  assert.equal(indiaCityFromLatlon(","), null);
  assert.equal(indiaCityFromLatlon(null), null);
  assert.equal(indiaCityFromLatlon(undefined), null);
});
