import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs, isRetryableHttpStatus } from "../httpRetry.js";

test("parseRetryAfterMs defaults to 1s when the header is absent", () => {
  assert.equal(parseRetryAfterMs(null), 1000);
});

test("parseRetryAfterMs reads the header as whole seconds", () => {
  assert.equal(parseRetryAfterMs("5"), 5000);
});

test("parseRetryAfterMs falls back to 1s on a non-numeric header", () => {
  // An HTTP-date Retry-After (RFC 1123) is not supported; it parses to NaN and takes the same 1s fallback.
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), 1000);
  assert.equal(parseRetryAfterMs("garbage"), 1000);
});

test("parseRetryAfterMs floors at 250ms", () => {
  assert.equal(parseRetryAfterMs("0.1"), 250);
  assert.equal(parseRetryAfterMs("0"), 250);
});

test("parseRetryAfterMs caps at 30s", () => {
  assert.equal(parseRetryAfterMs("120"), 30_000);
});

test("isRetryableHttpStatus flags rate limits and transient server errors", () => {
  for (const s of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableHttpStatus(s), true, `expected ${s} retryable`);
  }
});

test("isRetryableHttpStatus does NOT flag client errors or success", () => {
  for (const s of [200, 400, 401, 403, 404, 422, 501]) {
    assert.equal(isRetryableHttpStatus(s), false, `expected ${s} non-retryable`);
  }
});
