import { test } from "node:test";
import assert from "node:assert/strict";
import { hostMatchesName } from "./host-match.js";

test("hostMatchesName matches a >=4-char token in the host", () => {
  assert.equal(hostMatchesName("careers.acmecorp.com", "Acme Corp"), true);
});

test("hostMatchesName rejects a host with no matching token", () => {
  assert.equal(hostMatchesName("news.example.com", "Acme Corp"), false);
});

test("hostMatchesName strips www before matching", () => {
  assert.equal(hostMatchesName("www.acmecorp.com", "Acme Corp"), true);
});

test("hostMatchesName ignores tokens shorter than 4 chars (avoids acronym false positives)", () => {
  // "AB Inc" -> tokens "inc" (3 chars, filtered) and nothing else useful; "ab"
  // itself is only 2 chars and never becomes a token, so a host that merely
  // contains "ab" must not match.
  assert.equal(hostMatchesName("fabrikam.com", "AB Inc"), false);
});

test("hostMatchesName falls back to a 3-char prefix check for short names with no >=4-char tokens", () => {
  assert.equal(hostMatchesName("mpltech.com", "MPL"), true);
  assert.equal(hostMatchesName("other.com", "MPL"), false);
});
