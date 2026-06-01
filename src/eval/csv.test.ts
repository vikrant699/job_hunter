import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csv.js";

test("parses simple rows", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("keeps commas inside quoted fields", () => {
  assert.deepEqual(parseCsv('"x,y",z\n'), [["x,y", "z"]]);
});

test("unescapes doubled quotes", () => {
  assert.deepEqual(parseCsv('"a""b",c\n'), [['a"b', "c"]]);
});

test("handles CRLF and a final row without trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("returns empty array for empty input", () => {
  assert.deepEqual(parseCsv(""), []);
});
