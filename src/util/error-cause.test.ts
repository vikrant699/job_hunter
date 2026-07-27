import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, errorCauseCodes, isTransportError } from "./error-cause.js";

/** The exact shape undici produces for a DNS failure inside fetch(). */
function undiciDnsFailure(): Error {
  const cause = new Error("getaddrinfo ENOTFOUND nvidia.wd5.myworkdayjobs.com");
  Object.assign(cause, { code: "ENOTFOUND" });
  return new TypeError("fetch failed", { cause });
}

test("describeError keeps the cause that String(err) throws away", () => {
  const err = undiciDnsFailure();
  // The regression this guards: String(err) is the useless 23-char form.
  assert.equal(String(err), "TypeError: fetch failed");
  const described = describeError(err);
  assert.match(described, /TypeError: fetch failed/);
  assert.match(described, /ENOTFOUND/);
  assert.match(described, /nvidia\.wd5\.myworkdayjobs\.com/);
});

test("describeError does not duplicate a code already in the message", () => {
  const described = describeError(undiciDnsFailure());
  assert.equal(described.match(/ENOTFOUND/g)?.length, 1);
});

test("describeError appends a code that the message omits", () => {
  const cause = new Error("read failure");
  Object.assign(cause, { code: "ECONNRESET" });
  assert.match(describeError(new TypeError("fetch failed", { cause })), /\(ECONNRESET\)$/);
});

test("describeError handles a plain error, a non-error and a cycle", () => {
  assert.equal(describeError(new Error("boom")), "Error: boom");
  assert.equal(describeError("just a string"), "just a string");
  const a = new Error("a");
  Object.assign(a, { cause: a }); // self-referential cause must not hang
  assert.equal(describeError(a), "Error: a");
});

test("errorCauseCodes collects codes down the chain", () => {
  assert.deepEqual(errorCauseCodes(undiciDnsFailure()), ["ENOTFOUND"]);
  assert.deepEqual(errorCauseCodes(new Error("no code here")), []);
});

test("isTransportError is true for the run-29 outage signatures", () => {
  assert.ok(isTransportError(undiciDnsFailure()));
  const reset = new Error("socket hang up");
  Object.assign(reset, { code: "ECONNRESET" });
  assert.ok(isTransportError(reset));
  const again = new Error("getaddrinfo EAI_AGAIN host");
  Object.assign(again, { code: "EAI_AGAIN" });
  assert.ok(isTransportError(again));
  // bare TypeError with no cause still reads as transport (message match)
  assert.ok(isTransportError(new TypeError("fetch failed")));
});

test("isTransportError is false for board-shaped failures", () => {
  // These came FROM the board, so they are genuinely per-company and must
  // still count toward quarantine.
  assert.equal(isTransportError(new Error("greenhouse 404")), false);
  assert.equal(isTransportError(new Error("workday HTTP 403: permission denied")), false);
  assert.equal(isTransportError(new Error("gohire HTTP 429: limit exceeded")), false);
  assert.equal(isTransportError(new Error("workday list response failed schema")), false);
  assert.equal(isTransportError(new Error("oracle requires apiMeta.siteNumber")), false);
  assert.equal(isTransportError(new SyntaxError("Unexpected token '<'")), false);
});
