import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  REMOTE_RE,
  unixToIso,
  parsePostedOn,
} from "./shared.js";

// helper: days between a past ISO string and now
function dayDelta(iso: string | null): number {
  assert.ok(iso !== null, "expected non-null ISO string");
  return Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
}

describe("REMOTE_RE", () => {
  it('matches "Remote"', () => assert.ok(REMOTE_RE.test("Remote")));
  it('matches "Work From Home"', () =>
    assert.ok(REMOTE_RE.test("Work From Home")));
  it('matches "WFH"', () => assert.ok(REMOTE_RE.test("WFH")));
  it('matches "Anywhere"', () => assert.ok(REMOTE_RE.test("Anywhere")));
  it('matches "Virtual Office"', () =>
    assert.ok(REMOTE_RE.test("Virtual Office")));
  it('does not match "On-site"', () => assert.ok(!REMOTE_RE.test("On-site")));
  it('does not match "Bengaluru"', () =>
    assert.ok(!REMOTE_RE.test("Bengaluru")));
  it('does not match "Promote"', () =>
    assert.ok(!REMOTE_RE.test("Promote")));
  it('does not match "Premote"', () =>
    assert.ok(!REMOTE_RE.test("Premote")));
});

describe("unixToIso", () => {
  it("converts epoch seconds to ISO string", () => {
    assert.strictEqual(
      unixToIso(1_700_000_000),
      new Date(1_700_000_000 * 1000).toISOString(),
    );
  });
  it("returns null for null", () => assert.strictEqual(unixToIso(null), null));
  it("returns null for undefined", () =>
    assert.strictEqual(unixToIso(undefined), null));
  it("returns null for 0", () => assert.strictEqual(unixToIso(0), null));
});

describe("parsePostedOn", () => {
  it("returns null for null input", () =>
    assert.strictEqual(parsePostedOn(null), null));
  it("returns null for empty string", () =>
    assert.strictEqual(parsePostedOn(""), null));
  it("returns null for unrecognised garbage", () =>
    assert.strictEqual(parsePostedOn("garbage"), null));
  it('"Posted Today" => 0 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("Posted Today")), 0));
  it('"Posted Yesterday" => 1 day ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("Posted Yesterday")), 1));
  it('"5 Days Ago" => 5 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("5 Days Ago")), 5));
  it('"2 Weeks Ago" => 14 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("2 Weeks Ago")), 14));
  it('"3 Months Ago" => 90 days ago', () =>
    assert.strictEqual(dayDelta(parsePostedOn("3 Months Ago")), 90));
});
