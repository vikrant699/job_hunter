import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsv, parseCsv } from "./csv.js";

test("buildCsv emits header + rows joined by CRLF, quoting cells that need it", () => {
  const csv = buildCsv(
    ["Kind", "Company", "Job title", "Job URL", "Score", "Tier", "Reason/Error"],
    [
      ["match", "Acme", "Senior Data Analyst", "https://acme/1", 0.85, "green", "Direct analyst match"],
      ["match", "Acme", "BI Analyst", "https://acme/2", 0.6, "yellow", "Borderline but plausible"],
      ["company", "Globex", "", "", "", "", "broken (404 on careers page)"],
      ["company", "Initech", "", "", "", "", "manual (no adapter)"],
    ],
  );

  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "Kind,Company,Job title,Job URL,Score,Tier,Reason/Error");
  assert.equal(lines[1], "match,Acme,Senior Data Analyst,https://acme/1,0.85,green,Direct analyst match");
  assert.equal(lines[2], "match,Acme,BI Analyst,https://acme/2,0.6,yellow,Borderline but plausible");
  assert.equal(lines[3], "company,Globex,,,,,broken (404 on careers page)");
  assert.equal(lines[4], "company,Initech,,,,,manual (no adapter)");
});

test("buildCsv leaves a blank cell for null/undefined and quotes commas", () => {
  const csv = buildCsv(
    ["Kind", "Company", "Job title", "Job URL", "Score", "Tier", "Reason/Error"],
    [["match", "Acme, Inc", "Analyst", "https://x", null, "green", "n/a"]],
  );
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[1], 'match,"Acme, Inc",Analyst,https://x,,green,n/a');
});

test("parseCsv parses simple rows", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv keeps commas inside quoted fields", () => {
  assert.deepEqual(parseCsv('"x,y",z\n'), [["x,y", "z"]]);
});

test("parseCsv unescapes doubled quotes", () => {
  assert.deepEqual(parseCsv('"a""b",c\n'), [['a"b', "c"]]);
});

test("parseCsv handles CRLF and a final row without trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv returns empty array for empty input", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("parseCsv normalizes CRLF inside a quoted field to \\n (no stray \\r in the value)", () => {
  assert.deepEqual(parseCsv('"line1\r\nline2",x\r\n'), [["line1\nline2", "x"]]);
});
