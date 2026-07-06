// src/pipeline/posting-pipeline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedResult, verdictResult } from "./posting-pipeline.js";

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
