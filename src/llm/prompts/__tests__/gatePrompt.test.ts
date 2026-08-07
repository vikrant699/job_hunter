import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { GATE_PROMPT } from "../gate.js";

test("keeps every placeholder render() needs", () => {
  for (const ph of ["{{resume}}", "{{hardDealBreakers}}", "{{softDealBreakers}}", "{{jobTitle}}", "{{companyName}}", "{{jdText}}"]) {
    assert.ok(GATE_PROMPT.includes(ph), `missing ${ph}`);
  }
});

test("asks for analysis before matchScore (reason-first ordering)", () => {
  assert.ok(GATE_PROMPT.indexOf('"analysis"') < GATE_PROMPT.indexOf('"matchScore"'));
});

test("names all four sub-scores and forbids defaulting to 0.5", () => {
  for (const k of ["skillsMatch", "domainFit", "seniorityFit", "roleTypeMatch"]) {
    assert.ok(GATE_PROMPT.includes(k), `missing sub-score ${k}`);
  }
  assert.match(GATE_PROMPT, /do not (cluster|default).*0\.5/i);
});

test("worked-example JSON keys are all valid schema fields", () => {
  const SCHEMA_KEYS = new Set([
    "analysis", "skillsMatch", "domainFit", "seniorityFit", "roleTypeMatch",
    "matchScore", "dealBreakerHit", "dealBreakerSeverity", "reason",
  ]);
  const examples = GATE_PROMPT.match(/^\{"analysis".*\}$/gm) ?? [];
  assert.ok(examples.length >= 2, "expected at least two worked examples");
  for (const ex of examples) {
    for (const key of Object.keys(z.record(z.unknown()).parse(JSON.parse(ex)))) {
      assert.ok(SCHEMA_KEYS.has(key), `example uses non-schema key: ${key}`);
    }
  }
});
