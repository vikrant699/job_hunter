import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeError,
  errorCauseCodes,
  isEdgeInterstitialError,
  isInfrastructureFault,
  isTransportError,
} from "./error-cause.js";

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

/**
 * The real thing: whatever this Node's V8 phrases a JSON.parse failure as, so
 * the classifier is tested against the live message rather than a copy of it.
 */
function jsonParseFailure(body: string): unknown {
  try {
    JSON.parse(body);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${body} to fail JSON.parse`);
}

/** Verbatim from run 31 (2026-08-01), all 17 Workday boards. */
const RUN_31_MESSAGE = `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`;

test("isEdgeInterstitialError catches the run-31 HTML-for-JSON signature", () => {
  assert.ok(isEdgeInterstitialError(new SyntaxError(RUN_31_MESSAGE)));
  assert.ok(isEdgeInterstitialError(jsonParseFailure("<!DOCTYPE html><html></html>")));
});

test("isEdgeInterstitialError tolerates vendor casing and a bare <html", () => {
  assert.ok(isEdgeInterstitialError(jsonParseFailure('<!doctype html>\n<html lang="en">')));
  assert.ok(isEdgeInterstitialError(jsonParseFailure("<html><body>Access Denied</body></html>")));
});

test("isEdgeInterstitialError sees through an adapter that wraps the parse error", () => {
  const wrapped = new Error("workday list fetch failed", {
    cause: new SyntaxError(RUN_31_MESSAGE),
  });
  assert.ok(isEdgeInterstitialError(wrapped));
});

test("isEdgeInterstitialError is false for failures the board really produced", () => {
  // Malformed but JSON-shaped: the board's application answered, badly.
  assert.equal(isEdgeInterstitialError(jsonParseFailure("xnot json")), false);
  // Truncated body — also the board, so it must keep counting toward quarantine.
  assert.equal(isEdgeInterstitialError(jsonParseFailure('{"jobs":')), false);
  assert.equal(isEdgeInterstitialError(new Error("Unexpected end of JSON input")), false);
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 404")), false);
  assert.equal(
    isEdgeInterstitialError(
      new Error("workday tenant URL missing site segment: https://x.wd5.myworkdayjobs.com"),
    ),
    false,
  );
  // An HTTP status error whose body snippet happens to be HTML is still an HTTP
  // status error — no JSON parse was attempted, so the tag alone proves nothing.
  assert.equal(isEdgeInterstitialError(new Error("workday HTTP 520: <!DOCTYPE html>")), false);
});

test("the two infrastructure predicates stay disjoint", () => {
  // A DNS death is transport-shaped, and must not be what the new predicate catches.
  assert.equal(isEdgeInterstitialError(undiciDnsFailure()), false);
  assert.ok(isTransportError(undiciDnsFailure()));
  // An interstitial arrives over a healthy socket (HTTP 200), so it is not transport.
  assert.equal(isTransportError(jsonParseFailure("<!DOCTYPE html>")), false);
});

/**
 * The union of the two is what every caller actually wants to route on, so it
 * lives here rather than being re-derived per call site. The JD-fetch loop in
 * pipeline/posting-pipeline.ts checked only isTransportError until it used this,
 * which is why an edge page there dropped the posting with zero retries.
 */
test("isInfrastructureFault covers both shapes the board is not to blame for", () => {
  assert.ok(isInfrastructureFault(undiciDnsFailure()));
  assert.ok(isInfrastructureFault(new SyntaxError(RUN_31_MESSAGE)));
  assert.ok(isInfrastructureFault(jsonParseFailure("<!DOCTYPE html><html></html>")));
  // Wrapped by an adapter, as the real ones do.
  assert.ok(
    isInfrastructureFault(
      new Error("workday list fetch failed", { cause: new SyntaxError(RUN_31_MESSAGE) }),
    ),
  );
});

test("isInfrastructureFault is false for board defects, which must still count", () => {
  assert.equal(isInfrastructureFault(new Error("greenhouse 404")), false);
  assert.equal(isInfrastructureFault(new Error("workday HTTP 403: permission denied")), false);
  assert.equal(isInfrastructureFault(new Error("oracle requires apiMeta.siteNumber")), false);
  // Malformed but JSON-shaped, and truncated: the board's application answered.
  assert.equal(isInfrastructureFault(jsonParseFailure("xnot json")), false);
  assert.equal(isInfrastructureFault(jsonParseFailure('{"jobs":')), false);
});
