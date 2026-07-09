// src/blast/bounces.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepBounces, bounceQuery, type SweepDeps } from "./bounces.js";
import type { BlastRecord, BlastState } from "./state.js";

const NOW = new Date("2026-07-20T05:30:00.000Z");

function record(overrides: Partial<BlastRecord>): BlastRecord {
  return {
    email: "a@x.com", company: "X", contactName: null,
    status: "drafted", batch: 1, variant: "S1/O1", draftId: "d1",
    at: "2026-07-13T05:30:00.000Z", note: null,
    ...overrides,
  };
}

function fakeDeps(bouncedEmails: string[]): { deps: SweepDeps; queries: string[] } {
  const queries: string[] = [];
  const deps: SweepDeps = {
    searchMessages: (_profileId, q) => {
      queries.push(q);
      const hit = bouncedEmails.some((e) => q.includes(`"${e}"`));
      return Promise.resolve(hit ? [{ id: "m1", threadId: "t1" }] : []);
    },
    getMessageMetadata: () => Promise.resolve({ snippet: "Address not found", internalDate: NOW.getTime() }),
    now: () => NOW,
  };
  return { deps, queries };
}

test("bounceQuery quotes the address and anchors after: in epoch seconds", () => {
  const q = bounceQuery("a@x.com", "2026-07-13T05:30:00.000Z");
  assert.equal(q, `from:(mailer-daemon OR postmaster) "a@x.com" after:1783920600`);
});

test("marks recent drafted records bounced with a snippet note; leaves clean ones drafted", async () => {
  const state: BlastState = {
    lastSweepAt: null,
    records: [record({ email: "dead@x.com" }), record({ email: "fine@x.com" })],
  };
  const { deps } = fakeDeps(["dead@x.com"]);
  const result = await sweepBounces("divya", state, deps);
  assert.equal(result.checked, 2);
  assert.equal(result.newlyBounced, 1);
  assert.equal(state.records[0]?.status, "bounced");
  assert.equal(state.records[0]?.note, "Address not found");
  assert.equal(state.records[1]?.status, "drafted");
});

test("skips old records, already-bounced, and skipped_invalid", async () => {
  const state: BlastState = {
    lastSweepAt: null,
    records: [
      record({ email: "old@x.com", at: "2026-06-01T00:00:00.000Z" }),
      record({ email: "gone@x.com", status: "bounced" }),
      record({ email: "bad@x.com", status: "skipped_invalid", variant: null, draftId: null }),
      record({ email: "fresh@x.com" }),
    ],
  };
  const { deps, queries } = fakeDeps([]);
  const result = await sweepBounces("divya", state, deps);
  assert.equal(result.checked, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0] ?? "", /"fresh@x\.com"/);
});

test("lastBatch stats cover the highest batch only, excluding skips", async () => {
  const state: BlastState = {
    lastSweepAt: null,
    records: [
      record({ email: "b1@x.com", batch: 1 }),
      record({ email: "b2a@x.com", batch: 2, at: "2026-07-19T05:30:00.000Z" }),
      record({ email: "b2b@x.com", batch: 2, at: "2026-07-19T05:30:00.000Z" }),
      record({ email: "b2skip@x.com", batch: 2, status: "skipped_invalid", variant: null, draftId: null }),
    ],
  };
  const { deps } = fakeDeps(["b2a@x.com"]);
  const result = await sweepBounces("divya", state, deps);
  assert.deepEqual(result.lastBatch, { batch: 2, total: 2, bounced: 1, ratePct: 50 });
});

test("lastBatch is null when nothing has ever been drafted", async () => {
  const { deps } = fakeDeps([]);
  const result = await sweepBounces("divya", { lastSweepAt: null, records: [] }, deps);
  assert.equal(result.lastBatch, null);
});
