// src/blast/pool.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPool } from "./pool.js";

const HEADER = ["Company", "Email", "Contact Name", "Alt Names"];

test("skips the header row and preserves sheet order", () => {
  const pool = buildPool(
    [HEADER, ["B Corp", "b@b.com", "", ""], ["A Corp", "a@a.com", "", ""]],
    new Set(),
  );
  assert.deepEqual(pool.map((c) => c.email), ["b@b.com", "a@a.com"]);
});

test("splits multi-email cells on '/' and ',' and lowercases", () => {
  const pool = buildPool([HEADER, ["X", "One@x.com / two@x.com, THREE@x.com", "", ""]], new Set());
  assert.deepEqual(pool.map((c) => c.email), ["one@x.com", "two@x.com", "three@x.com"]);
  assert.equal(pool[0]?.company, "X");
});

test("drops junk cells, no-reply addresses, and duplicates within the tab", () => {
  const pool = buildPool(
    [
      HEADER,
      ["X", "not-an-email", "", ""],
      ["X", "noreply@x.com", "", ""],
      ["X", "no-reply@y.com", "", ""],
      ["X", "donotreply@z.com", "", ""],
      ["X", "real@x.com", "", ""],
      ["Y", "REAL@x.com", "", ""],
    ],
    new Set(),
  );
  assert.deepEqual(pool.map((c) => c.email), ["real@x.com"]);
});

test("excludes already-processed addresses (state's knownEmails)", () => {
  const pool = buildPool(
    [HEADER, ["X", "done@x.com", "", ""], ["Y", "new@y.com", "", ""]],
    new Set(["done@x.com"]),
  );
  assert.deepEqual(pool.map((c) => c.email), ["new@y.com"]);
});

test("contactName is null when blank, trimmed otherwise", () => {
  const pool = buildPool(
    [HEADER, ["X", "a@x.com", "  ", ""], ["Y", "b@y.com", " Priya Sharma ", ""]],
    new Set(),
  );
  assert.equal(pool[0]?.contactName, null);
  assert.equal(pool[1]?.contactName, "Priya Sharma");
});
