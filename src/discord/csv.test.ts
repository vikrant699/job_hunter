import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchedCsv } from "./attachments.js";

test("buildSearchedCsv emits match rows then company rows under one Kind schema", () => {
  const csv = buildSearchedCsv(
    [
      { company: "Acme", title: "Senior Data Analyst", url: "https://acme/1", score: 0.85, tier: "green", reason: "Direct analyst match" },
      { company: "Acme", title: "BI Analyst", url: "https://acme/2", score: 0.6, tier: "yellow", reason: "Borderline but plausible" },
    ],
    [
      { company: "Globex", reason: "broken (404 on careers page)" },
      { company: "Initech", reason: "manual (no adapter)" },
    ],
  );

  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "Kind,Company,Job title,Job URL,Score,Tier,Reason/Error");
  assert.equal(lines[1], "match,Acme,Senior Data Analyst,https://acme/1,0.85,green,Direct analyst match");
  assert.equal(lines[2], "match,Acme,BI Analyst,https://acme/2,0.6,yellow,Borderline but plausible");
  assert.equal(lines[3], "company,Globex,,,,,broken (404 on careers page)");
  assert.equal(lines[4], "company,Initech,,,,,manual (no adapter)");
});

test("buildSearchedCsv leaves Score blank when null and quotes commas", () => {
  const csv = buildSearchedCsv(
    [{ company: "Acme, Inc", title: "Analyst", url: "https://x", score: null, tier: "green", reason: "n/a" }],
    [],
  );
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[1], 'match,"Acme, Inc",Analyst,https://x,,green,n/a');
});
