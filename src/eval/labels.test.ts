import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLabels } from "./labels.js";

const CSV =
  "id,company,reaction\n" +
  "workday:R1,Acme,Relevant\n" +
  "workday:R2,Acme,Irrelevant\n" +
  "lever:abc,Beta,y\n" +
  "lever:def,Beta,n\n" +
  "greenhouse:9,Gamma,\n";

test("maps relevant/irrelevant and y/n to booleans", () => {
  const { labels } = parseLabels(CSV);
  assert.equal(labels.get("workday:R1"), true);
  assert.equal(labels.get("workday:R2"), false);
  assert.equal(labels.get("lever:abc"), true);
  assert.equal(labels.get("lever:def"), false);
});

test("skips blank/unrecognized reactions and counts them", () => {
  const { labels, skipped } = parseLabels(CSV);
  assert.equal(labels.has("greenhouse:9"), false);
  assert.equal(skipped, 1);
});

test("throws when required columns are missing", () => {
  assert.throws(() => parseLabels("foo,bar\n1,2\n"), /id.*reaction/);
});
