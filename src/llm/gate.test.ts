import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGateResponse } from "./gate.js";

test("parses the v1 shape", () => {
  const g = parseGateResponse('{"matchScore":0.7,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"ok"}');
  assert.equal(g.matchScore, 0.7);
  assert.equal(g.dealBreakerHit, null);
});

test("parses the v2 shape and keeps sub-scores", () => {
  const raw = '{"analysis":"a","skillsMatch":0.9,"domainFit":0.6,"seniorityFit":0.8,"roleTypeMatch":1,"matchScore":0.82,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"good"}';
  const g = parseGateResponse(raw);
  assert.equal(g.matchScore, 0.82);
  assert.equal(g.skillsMatch, 0.9);
  assert.equal(g.roleTypeMatch, 1);
});

test("normalizes empty/none dealbreaker to null", () => {
  const g = parseGateResponse('{"matchScore":0.5,"dealBreakerHit":"none","dealBreakerSeverity":"none","reason":"x"}');
  assert.equal(g.dealBreakerHit, null);
  assert.equal(g.dealBreakerSeverity, null);
});

test("defaults severity to soft when a hit has no severity", () => {
  const g = parseGateResponse('{"matchScore":0.5,"dealBreakerHit":"contract role","dealBreakerSeverity":null,"reason":"x"}');
  assert.equal(g.dealBreakerSeverity, "soft");
});

test("throws on non-JSON and on schema violations", () => {
  assert.throws(() => parseGateResponse("not json"), /not JSON/);
  assert.throws(() => parseGateResponse('{"reason":"missing score"}'), /schema validation/);
});

test("rejects an out-of-range matchScore", () => {
  assert.throws(() => parseGateResponse('{"matchScore":1.1,"dealBreakerHit":null,"dealBreakerSeverity":null,"reason":"x"}'), /schema validation/);
});

test("passes a hard deal-breaker through unchanged", () => {
  const g = parseGateResponse('{"matchScore":0,"dealBreakerHit":"staffing agency","dealBreakerSeverity":"hard","reason":"x"}');
  assert.equal(g.dealBreakerHit, "staffing agency");
  assert.equal(g.dealBreakerSeverity, "hard");
});

test("parseGateResponse fills a fallback reason when the model omits it", () => {
  const raw = JSON.stringify({
    analysis: "Core SQL + dashboards analyst work.",
    matchScore: 0.82,
    dealBreakerHit: null,
    dealBreakerSeverity: null,
    // reason intentionally absent
  });
  const r = parseGateResponse(raw);
  assert.equal(r.matchScore, 0.82);
  assert.ok(r.reason.length > 0, "reason should be backfilled, not empty");
});

test("parseGateResponse coerces an omitted dealBreakerSeverity (hit set) to soft", () => {
  const raw = JSON.stringify({
    analysis: "SDET role, not frontend.",
    matchScore: 0.25,
    dealBreakerHit: "Role focuses on SDET/DevOps rather than frontend UI.",
    // dealBreakerSeverity intentionally absent
    reason: "SDET, not frontend.",
  });
  const r = parseGateResponse(raw);
  assert.equal(r.dealBreakerSeverity, "soft");
  assert.equal(r.matchScore, 0.25);
});

test("parseGateResponse coerces both dealBreaker fields absent to null", () => {
  const raw = JSON.stringify({ matchScore: 0.7, reason: "ok" });
  const r = parseGateResponse(raw);
  assert.equal(r.dealBreakerHit, null);
  assert.equal(r.dealBreakerSeverity, null);
});
