import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonOrThrow, getObj, tryParseJson } from "../json.js";

test("parseJsonOrThrow returns the parsed value for valid JSON", () => {
  const v = parseJsonOrThrow('{"a":1,"b":[1,2,3]}', "widget");
  assert.deepEqual(v, { a: 1, b: [1, 2, 3] });
});

test("parseJsonOrThrow throws a labeled error on invalid JSON", () => {
  assert.throws(() => parseJsonOrThrow("not json", "widget"), /widget output not JSON:/);
});

test("parseJsonOrThrow includes the label in the thrown message for different labels", () => {
  assert.throws(() => parseJsonOrThrow("{bad", "gate"), /gate output not JSON:/);
  assert.throws(() => parseJsonOrThrow("{bad", "extract"), /extract output not JSON:/);
});

test("getObj returns the nested plain object at key", () => {
  const node = { foo: { bar: 1 } };
  assert.deepEqual(getObj(node, "foo"), { bar: 1 });
});

test("getObj returns null when the key is an array", () => {
  const node = { foo: [1, 2, 3] };
  assert.equal(getObj(node, "foo"), null);
});

test("getObj returns null when the key is null, missing, or a scalar", () => {
  const node = { foo: null, num: 5 };
  assert.equal(getObj(node, "foo"), null);
  assert.equal(getObj(node, "num"), null);
  assert.equal(getObj(node, "missing"), null);
});

test("getObj returns null when node itself is null or undefined", () => {
  assert.equal(getObj(null, "foo"), null);
  assert.equal(getObj(undefined, "foo"), null);
});

test("getObj with no key returns the same object when passed a plain object", () => {
  const obj = { bar: 1 };
  assert.equal(getObj(obj), obj);
});

test("getObj with no key returns null when passed an array", () => {
  assert.equal(getObj([1, 2, 3]), null);
});

test("getObj with no key returns null when passed a scalar", () => {
  assert.equal(getObj("x"), null);
});

test("tryParseJson returns the parsed object for valid JSON object text", () => {
  assert.deepEqual(tryParseJson('{"a":1,"b":[1,2,3]}'), { a: 1, b: [1, 2, 3] });
});

test("tryParseJson returns the parsed array for valid JSON array text", () => {
  assert.deepEqual(tryParseJson("[1,2,3]"), [1, 2, 3]);
});

test("tryParseJson returns the parsed scalar for valid JSON scalar text", () => {
  assert.equal(tryParseJson("42"), 42);
  assert.equal(tryParseJson('"hello"'), "hello");
  assert.equal(tryParseJson("true"), true);
});

test("tryParseJson returns null for malformed JSON", () => {
  assert.equal(tryParseJson("{not json"), null);
  assert.equal(tryParseJson("[1,2,"), null);
});

test("tryParseJson returns null for an empty string", () => {
  assert.equal(tryParseJson(""), null);
});
