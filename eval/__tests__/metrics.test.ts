// src/eval/metrics.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rocAuc, recallAtThreshold, precisionAtThreshold,
  maxThresholdForFullRecall, scoreSpread, type ScoredLabel,
} from "../metrics.js";

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

test("rocAuc on the multi-pair fixture is 5/6", () => {
  // pos=[0.9,0.7,0.4], neg=[0.5,0.2] → wins=5 of 6 pairs (0.4<0.5 is the only loss)
  assert.ok(Math.abs(rocAuc(rows) - 5 / 6) < 1e-9);
});

test("degenerate inputs return the NaN sentinel (contract for callers)", () => {
  assert.ok(Number.isNaN(rocAuc([])));
  assert.ok(Number.isNaN(rocAuc([{ score: 0.9, relevant: true }]))); // single class
  assert.ok(Number.isNaN(recallAtThreshold([{ score: 0.5, relevant: false }], 0.4))); // no relevants
  assert.ok(Number.isNaN(precisionAtThreshold([{ score: 0.2, relevant: true }], 0.9))); // none kept
  assert.ok(Number.isNaN(maxThresholdForFullRecall([]))); // no relevants
});

test("scoreSpread on empty input yields zero distinct and NaN modal/share", () => {
  const s = scoreSpread([]);
  assert.equal(s.distinct, 0);
  assert.ok(Number.isNaN(s.modal));
  assert.ok(Number.isNaN(s.modalShare));
});
