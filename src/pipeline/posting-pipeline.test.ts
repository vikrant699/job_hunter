// src/pipeline/posting-pipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedResult, verdictResult, lateLocationCheck } from "./posting-pipeline.js";
import type { NormalizedPosting } from "../types.js";

function posting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    provider: "ralphlauren",
    externalId: "1",
    companySlug: "ralph-lauren",
    companyName: "Ralph Lauren",
    jobTitle: "Analyst, Planning Applications",
    jobUrl: "https://careers.ralphlauren.com/en_US/CareersCorporate/JobDetailCorporate?jobId=57886",
    location: null,
    isRemote: false,
    jdText: "",
    postedAt: null,
    ...over,
  };
}

// An adapter may only learn the real location while fetching the JD (Avature's
// list API gives lat/lon and leaves many jobs ungeocoded). When it resolves one,
// that metadata must face the STRICT check — the text heuristic is the
// no-metadata fallback and would defer a foreign role to the LLM gate.
test("lateLocationCheck applies the strict metadata check when fetchJd resolved a location", () => {
  // "hong kong" is a listed rejectRegion, so that rule fires first.
  const listed = lateLocationCheck(posting({ location: "Tsim Sha Tsui, Kowloon, Hong Kong SAR" }));
  assert.equal(listed.accept, false);
  assert.equal(listed.reason, "geo-rejected");

  // A foreign place NOT on the reject list still fails for want of any
  // in-region signal — which is the whole point of using the strict check here.
  const unlisted = lateLocationCheck(posting({ location: "Tsim Sha Tsui, Kowloon" }));
  assert.equal(unlisted.accept, false);
  assert.equal(unlisted.reason, "out-of-region");

  const india = lateLocationCheck(posting({ location: "Bangalore, Karnataka, India" }));
  assert.equal(india.accept, true);
});

test("lateLocationCheck falls back to the text heuristic when the location is still unknown", () => {
  const r = lateLocationCheck(posting({ location: null, jdText: "Join our Bengaluru team." }));
  assert.equal(r.accept, true);
  assert.equal(r.reason, "in-region-text");
});

test("lateLocationCheck treats an empty-string location as unknown, not as a metadata reject", () => {
  const r = lateLocationCheck(posting({ location: "", jdText: "A frontend role." }));
  assert.equal(r.accept, true);
  assert.equal(r.reason, "unknown-defer");
});

test("droppedResult defaults confidence/yoe to null and always sets llmRelevant 0, notifiedAt null", () => {
  const r = droppedResult("no-jd", "no-jd");
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "no-jd",
    llmConfidence: null,
    yoeMin: null,
    yoeMax: null,
    dropStage: "no-jd",
    notifiedAt: null,
  });
});

test("droppedResult carries through confidence and yoe when provided (silent-drop shape)", () => {
  const r = droppedResult("below floor", "silent", { llmConfidence: 0.4, yoeMin: 2, yoeMax: 4 });
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "below floor",
    llmConfidence: 0.4,
    yoeMin: 2,
    yoeMax: 4,
    dropStage: "silent",
    notifiedAt: null,
  });
});

test("droppedResult (hard-deal-breaker shape): confidence set, yoe null", () => {
  const r = droppedResult("visa sponsorship required", "hard-deal-breaker", { llmConfidence: 0.9 });
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "visa sponsorship required",
    llmConfidence: 0.9,
    yoeMin: null,
    yoeMax: null,
    dropStage: "hard-deal-breaker",
    notifiedAt: null,
  });
});

test("verdictResult: green sets llmRelevant 1", () => {
  const r = verdictResult("green", "great fit", 0.85, { yoeMin: 3, yoeMax: 5, notifiedAt: "2026-07-06T00:00:00.000Z" });
  assert.deepEqual(r, {
    llmRelevant: 1,
    llmReason: "great fit",
    llmConfidence: 0.85,
    yoeMin: 3,
    yoeMax: 5,
    dropStage: null,
    notifiedAt: "2026-07-06T00:00:00.000Z",
  });
});

test("verdictResult: yellow sets llmRelevant 0 and defaults dropStage to null unless given", () => {
  const r = verdictResult("yellow", "borderline", 0.55, { notifiedAt: "2026-07-06T00:00:00.000Z" });
  assert.deepEqual(r, {
    llmRelevant: 0,
    llmReason: "borderline",
    llmConfidence: 0.55,
    yoeMin: null,
    yoeMax: null,
    dropStage: null,
    notifiedAt: "2026-07-06T00:00:00.000Z",
  });
});

test("verdictResult: dropStage 'yellow' final-write shape (not notified path uses dropStage explicitly)", () => {
  const r = verdictResult("yellow", "borderline", 0.55, { dropStage: "yellow", notifiedAt: null });
  assert.equal(r.dropStage, "yellow");
  assert.equal(r.notifiedAt, null);
});

test("verdictResult: duplicate shape prefixes reason and carries extract yoe", () => {
  const r = verdictResult("green", "duplicate: great fit", 0.85, { yoeMin: 3, yoeMax: 5, dropStage: "duplicate", notifiedAt: null });
  assert.deepEqual(r, {
    llmRelevant: 1,
    llmReason: "duplicate: great fit",
    llmConfidence: 0.85,
    yoeMin: 3,
    yoeMax: 5,
    dropStage: "duplicate",
    notifiedAt: null,
  });
});
