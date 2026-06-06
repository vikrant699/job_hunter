import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_V2 } from "./gate-v2.js";

test("keeps every placeholder render() needs", () => {
  for (const ph of ["{{resume}}", "{{hardDealBreakers}}", "{{softDealBreakers}}", "{{jobTitle}}", "{{companyName}}", "{{jdText}}"]) {
    assert.ok(GATE_V2.includes(ph), `missing ${ph}`);
  }
});

test("asks for analysis before matchScore (reason-first ordering)", () => {
  assert.ok(GATE_V2.indexOf('"analysis"') < GATE_V2.indexOf('"matchScore"'));
});

test("names all four sub-scores and forbids defaulting to 0.5", () => {
  for (const k of ["skillsMatch", "domainFit", "seniorityFit", "roleTypeMatch"]) {
    assert.ok(GATE_V2.includes(k), `missing sub-score ${k}`);
  }
  assert.match(GATE_V2, /do not (cluster|default).*0\.5/i);
});

test("worked-example JSON keys are all valid schema fields", () => {
  const SCHEMA_KEYS = new Set([
    "analysis", "skillsMatch", "domainFit", "seniorityFit", "roleTypeMatch",
    "matchScore", "dealBreakerHit", "dealBreakerSeverity", "reason",
  ]);
  const examples = GATE_V2.match(/^\{"analysis".*\}$/gm) ?? [];
  assert.ok(examples.length >= 2, "expected at least two worked examples");
  for (const ex of examples) {
    for (const key of Object.keys(JSON.parse(ex))) {
      assert.ok(SCHEMA_KEYS.has(key), `example uses non-schema key: ${key}`);
    }
  }
});
