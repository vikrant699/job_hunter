import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, loadAllStates, saveState, emptyState, knownEmails, draftedEverCount, maxBatch, statePathFor } from "../state.js";
import type { BlastRecord } from "../state.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "blast-state-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(overrides: Partial<BlastRecord>): BlastRecord {
  return {
    email: "a@x.com", company: "X Ltd", contactName: null,
    status: "drafted", batch: 1, variant: "S1/O1", draftId: "d1",
    at: "2026-07-13T05:30:00.000Z", note: null,
    ...overrides,
  };
}

test("loadState returns empty state when the file does not exist", () => {
  withTempDir((dir) => {
    assert.deepEqual(loadState(join(dir, "missing.json")), emptyState());
  });
});

test("saveState/loadState round-trips and leaves no temp file behind", () => {
  withTempDir((dir) => {
    const path = join(dir, "state.json");
    const state = { lastSweepAt: "2026-07-13T05:00:00.000Z", records: [record({})] };
    saveState(path, state);
    assert.deepEqual(loadState(path), state);
    assert.equal(existsSync(`${path}.tmp-${process.pid}`), false);
  });
});

test("loadState throws on a malformed file instead of silently restarting the campaign", () => {
  withTempDir((dir) => {
    const path = join(dir, "state.json");
    writeFileSync(path, '{"records": "oops"}', "utf-8");
    assert.throws(() => loadState(path), /blast state at/);
  });
});

test("saveState creates the parent directory when missing", () => {
  withTempDir((dir) => {
    const path = join(dir, "nested", "deeper", "state.json");
    saveState(path, emptyState());
    assert.equal(readFileSync(path, "utf-8").includes('"records"'), true);
  });
});

test("selectors: knownEmails, draftedEverCount (excludes skips), maxBatch", () => {
  const state = {
    lastSweepAt: null,
    records: [
      record({ email: "a@x.com", status: "drafted", batch: 1 }),
      record({ email: "b@x.com", status: "bounced", batch: 1 }),
      record({ email: "c@x.com", status: "skipped_invalid", batch: 2, variant: null, draftId: null }),
    ],
  };
  assert.deepEqual([...knownEmails(state)].sort(), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal(draftedEverCount(state), 2);
  assert.equal(maxBatch(state), 2);
  assert.equal(maxBatch(emptyState()), 0);
});

test("statePathFor is per-profile under data/", () => {
  assert.equal(statePathFor("divya"), "data/blast-state-divya.json");
});

test("loadAllStates finds every profile's state file, sorted, ignoring other files", () => {
  withTempDir((dir) => {
    saveState(join(dir, "blast-state-vikrant.json"), { lastSweepAt: null, records: [record({ email: "v@x.com" })] });
    saveState(join(dir, "blast-state-divya.json"), { lastSweepAt: null, records: [record({})] });
    writeFileSync(join(dir, "job_hunter.db"), "not a state file", "utf-8");
    const all = loadAllStates(dir);
    assert.deepEqual(all.map((s) => s.profileId), ["divya", "vikrant"]);
    assert.equal(all[1]?.state.records[0]?.email, "v@x.com");
  });
  assert.deepEqual(loadAllStates("does-not-exist"), []);
});
