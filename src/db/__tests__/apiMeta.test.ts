import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApiMeta } from "../apiMeta.js";

test("parseApiMeta: parses a JSON object", () => {
  assert.deepEqual(parseApiMeta('{"orgGuid":"abc"}'), { orgGuid: "abc" });
});
test("parseApiMeta: null/garbage → null", () => {
  assert.equal(parseApiMeta(null), null);
  assert.equal(parseApiMeta("not json"), null);
  assert.equal(parseApiMeta("[1,2]"), null); // arrays are not a token map
});
