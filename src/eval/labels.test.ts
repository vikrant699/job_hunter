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

test("throws when only one required column is present", () => {
  assert.throws(() => parseLabels("reaction,value\nRelevant,2\n"));
  assert.throws(() => parseLabels("id,value\nlever:x,2\n"));
});

test("accepts yes/no as aliases for relevant/irrelevant", () => {
  const { labels } = parseLabels("id,reaction\nlever:yy,yes\nlever:nn,no\n");
  assert.equal(labels.get("lever:yy"), true);
  assert.equal(labels.get("lever:nn"), false);
});
