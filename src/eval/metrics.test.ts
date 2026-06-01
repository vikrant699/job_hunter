// src/eval/metrics.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rocAuc, recallAtThreshold, precisionAtThreshold,
  maxThresholdForFullRecall, scoreSpread, type ScoredLabel,
} from "./metrics.js";

const rows: ScoredLabel[] = [
  { score: 0.9, relevant: true },
  { score: 0.7, relevant: true },
  { score: 0.4, relevant: true },
  { score: 0.5, relevant: false },
  { score: 0.2, relevant: false },
];

test("rocAuc: perfect separation is 1, reversed is 0, all-tie is 0.5", () => {
  assert.equal(rocAuc([{ score: 0.9, relevant: true }, { score: 0.1, relevant: false }]), 1);
  assert.equal(rocAuc([{ score: 0.1, relevant: true }, { score: 0.9, relevant: false }]), 0);
  assert.equal(rocAuc([{ score: 0.5, relevant: true }, { score: 0.5, relevant: false }]), 0.5);
});

test("recallAtThreshold counts relevants kept", () => {
  assert.ok(Math.abs(recallAtThreshold(rows, 0.5) - 2 / 3) < 1e-9);
});

test("precisionAtThreshold counts relevants among kept", () => {
  assert.ok(Math.abs(precisionAtThreshold(rows, 0.5) - 2 / 3) < 1e-9);
});

test("maxThresholdForFullRecall is the min relevant score", () => {
  assert.equal(maxThresholdForFullRecall(rows), 0.4);
});

test("scoreSpread reports distinct count and modal share", () => {
  const s = scoreSpread([0.5, 0.5, 0.5, 0.7]);
  assert.equal(s.distinct, 2);
  assert.equal(s.modal, 0.5);
  assert.equal(s.modalShare, 0.75);
});
