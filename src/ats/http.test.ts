// src/ats/http.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { atsHttpError } from "./http.js";

test("atsHttpError: 404 gives a short provider-tagged message", () => {
  const e = atsHttpError("keka", 404, "<html>not found</html>");
  assert.equal(e.message, "keka 404");
});

test("atsHttpError: non-404 includes status and a trimmed body snippet", () => {
  const e = atsHttpError("oracle", 500, "x".repeat(500));
  assert.match(e.message, /^oracle HTTP 500: x+$/);
  assert.ok(e.message.length < 230, "body snippet should be capped at ~200 chars");
});

test("atsHttpError builds 404 and generic errors", () => {
  assert.equal(atsHttpError("phenom", 404, "x").message, "phenom 404");
  assert.match(atsHttpError("phenom", 500, "boom").message, /phenom HTTP 500: boom/);
});
