// src/ats/http.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { atsHttpError, atsFetchHtml, atsFetchText } from "./http.js";
import { stubFetch } from "./test-helpers.js";

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

test("atsFetchHtml returns the response body, falling back to the requested URL when res.url is empty", async (t) => {
  // The Response constructor can't set a synthetic .url (it's read-only,
  // populated by a real fetch), so this exercises the `res.url || url` fallback.
  stubFetch(t, async () => new Response("<html>hi</html>", { status: 200 }));
  const { html, finalUrl } = await atsFetchHtml("https://example.com/careers", { provider: "phenom" });
  assert.equal(html, "<html>hi</html>");
  assert.equal(finalUrl, "https://example.com/careers");
});

test("atsFetchHtml throws atsHttpError on a non-OK response", async (t) => {
  stubFetch(t, async () => new Response("not found", { status: 404 }));
  await assert.rejects(atsFetchHtml("https://example.com/careers", { provider: "keka" }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "keka 404");
    return true;
  });
});

test("atsFetchText is a thin wrapper that discards finalUrl", async (t) => {
  stubFetch(t, async () => new Response("plain text body", { status: 200 }));
  const text = await atsFetchText("https://example.com/careers", { provider: "keka" });
  assert.equal(text, "plain text body");
});
