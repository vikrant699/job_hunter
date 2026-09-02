import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { insertBoardRun } from "../boardRuns.js";
import { db } from "../db.js";

const BoardRunRowSchema = z.object({
  status: z.string(),
  added: z.number(),
  removed: z.number(),
  unchanged: z.number(),
  error: z.string().nullable(),
  run_at: z.string(),
});

function boardRunRows(provider: string, companySlug: string) {
  const rows = db
    .prepare("SELECT status, added, removed, unchanged, error, run_at FROM board_runs WHERE provider = ? AND company_slug = ? ORDER BY run_at DESC")
    .all(provider, companySlug);
  return rows.map((r) => BoardRunRowSchema.parse(r));
}

test("insertBoardRun writes a row with the given fields", () => {
  const slug = `br-basic-${Date.now()}`;
  const runAt = new Date().toISOString();
  insertBoardRun({
    provider: "custom",
    companySlug: slug,
    profileId: "default",
    runAt,
    status: "ok",
    added: 2,
    removed: 1,
    unchanged: 3,
    error: null,
  });

  const rows = boardRunRows("custom", slug);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "ok");
  assert.equal(rows[0].added, 2);
  assert.equal(rows[0].removed, 1);
  assert.equal(rows[0].unchanged, 3);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].run_at, runAt);
});

test("insertBoardRun records an error row with the message and zeroed counts", () => {
  const slug = `br-error-${Date.now()}`;
  insertBoardRun({
    provider: "custom",
    companySlug: slug,
    profileId: "default",
    runAt: new Date().toISOString(),
    status: "error",
    added: 0,
    removed: 0,
    unchanged: 0,
    error: "board-shaped failure: 404",
  });

  const rows = boardRunRows("custom", slug);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "error");
  assert.equal(rows[0].error, "board-shaped failure: 404");
});

test("insertBoardRun prunes a board's history to the newest 60 rows", () => {
  const slug = `br-prune-${Date.now()}`;
  const base = Date.now();
  for (let i = 0; i < 65; i++) {
    insertBoardRun({
      provider: "custom",
      companySlug: slug,
      profileId: "default",
      runAt: new Date(base + i).toISOString(),
      status: "ok",
      added: i,
      removed: 0,
      unchanged: 0,
      error: null,
    });
  }

  const rows = boardRunRows("custom", slug);
  assert.equal(rows.length, 60, "only the newest 60 runs survive");
  // Newest-first: the surviving rows are runs 5..64 (added=i), so the oldest kept run has added=5.
  const oldestKept = rows[rows.length - 1];
  assert.equal(oldestKept?.added, 5);
  assert.equal(rows[0]?.added, 64, "the most recent run must survive");
});

test("insertBoardRun prunes independently per (provider, company_slug)", () => {
  const slugA = `br-scope-a-${Date.now()}`;
  const slugB = `br-scope-b-${Date.now()}`;
  insertBoardRun({
    provider: "custom", companySlug: slugA, profileId: "default",
    runAt: new Date().toISOString(), status: "ok", added: 1, removed: 0, unchanged: 0, error: null,
  });
  insertBoardRun({
    provider: "custom", companySlug: slugB, profileId: "default",
    runAt: new Date().toISOString(), status: "ok", added: 9, removed: 0, unchanged: 0, error: null,
  });

  assert.equal(boardRunRows("custom", slugA).length, 1);
  assert.equal(boardRunRows("custom", slugB).length, 1);
  assert.equal(boardRunRows("custom", slugB)[0]?.added, 9);
});
