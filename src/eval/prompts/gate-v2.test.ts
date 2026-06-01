import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_V2 } from "./gate-v2.js";

test("keeps every placeholder render() needs", () => {
  for (const ph of ["{{summary}}", "{{hardDealBreakers}}", "{{softDealBreakers}}", "{{jobTitle}}", "{{companyName}}", "{{jdText}}"]) {
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
