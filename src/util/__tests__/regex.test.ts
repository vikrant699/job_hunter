import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGroup } from "../regex.js";

test("matchGroup returns group 1 on match", () => {
  assert.equal(matchGroup(/id-(\d+)/, "job id-42 x"), "42");
});
test("matchGroup returns null on no match", () => {
  assert.equal(matchGroup(/id-(\d+)/, "nope"), null);
});
test("matchGroup returns null when the group did not participate", () => {
  assert.equal(matchGroup(/a(b)?c/, "ac"), null);
});
test("matchGroup picks a later group by index", () => {
  assert.equal(matchGroup(/(\d+)-(\d+)/, "3-7", 2), "7");
});
