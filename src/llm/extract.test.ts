// src/llm/extract.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtractResponse } from "./extract.js";

test("parseExtractResponse passes plain numbers and nulls through", () => {
  assert.deepEqual(parseExtractResponse('{"yoeMin": 3, "yoeMax": 5}'), { yoeMin: 3, yoeMax: 5 });
  assert.deepEqual(parseExtractResponse('{"yoeMin": null, "yoeMax": null}'), { yoeMin: null, yoeMax: null });
});

test("parseExtractResponse coerces numeric strings", () => {
  assert.deepEqual(parseExtractResponse('{"yoeMin": "2", "yoeMax": "4"}'), { yoeMin: 2, yoeMax: 4 });
});

test("parseExtractResponse maps empty/placeholder strings to null, never 0", () => {
  // "" must NOT become 0 — a 0 would make verdict.ts treat the YOE as known
  // and skip the unknown-YOE yellow safeguard.
  assert.deepEqual(parseExtractResponse('{"yoeMin": "", "yoeMax": " "}'), { yoeMin: null, yoeMax: null });
  assert.deepEqual(parseExtractResponse('{"yoeMin": "null", "yoeMax": "None"}'), { yoeMin: null, yoeMax: null });
});

test("parseExtractResponse maps unparseable strings to null", () => {
  assert.deepEqual(parseExtractResponse('{"yoeMin": "3-5 years", "yoeMax": "senior"}'), {
    yoeMin: null,
    yoeMax: null,
  });
});

test("parseExtractResponse throws on a non-object or missing fields", () => {
  assert.throws(() => parseExtractResponse("[1,2]"));
  assert.throws(() => parseExtractResponse('{"yoeMin": 3}'));
});
