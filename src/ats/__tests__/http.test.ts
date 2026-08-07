// src/ats/http.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { atsHttpError, atsFetchHtml, atsFetchText, atsFetchJson, parseOrThrow, parseOrNull } from "../http.js";
import { stubFetch, jsonResponse } from "./testHelpers.js";
import {
  startConnectivityMonitor,
  stopConnectivityMonitor,
  connectivityStatus,
} from "../../util/connectivity.js";

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
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
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

// withAtsTimeout builds the signal via AbortSignal.timeout(timeoutMs ?? config.fetch.timeoutMs)
// — the default duration itself is untestable without config injection (out of scope), but
// the two tests below pin what is pinnable: the signal reaches fetch, and an abort
// rejection propagates out of atsFetchJson rather than being swallowed.
test("atsFetchJson passes an abortable timeout signal to fetch", async (t) => {
  let sawSignal = false;
  stubFetch(t, (_url, init) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return Promise.resolve(jsonResponse({}));
  });
  await atsFetchJson("https://x.example/api");
  assert.equal(sawSignal, true);
});

test("atsFetchJson rejects when fetch rejects with an AbortError (timeout signal fired)", async (t) => {
  stubFetch(t, () => Promise.reject(new DOMException("This operation was aborted", "AbortError")));
  await assert.rejects(atsFetchJson("https://x.example/api"), /abort/i);
});

test("parseOrThrow returns the typed value on success", () => {
  const S = z.object({ a: z.number() });
  assert.deepEqual(parseOrThrow(S, { a: 1 }, { provider: "x", slug: "acme" }), { a: 1 });
});
test("parseOrThrow throws with provider/slug and 'schema' in the message on mismatch", () => {
  const S = z.object({ a: z.number() });
  assert.throws(() => parseOrThrow(S, { a: "no" }, { provider: "x", slug: "acme", what: "list" }),
    /x list response failed schema for acme/);
});
test("parseOrNull returns null on mismatch", () => {
  const S = z.object({ a: z.number() });
  assert.equal(parseOrNull(S, { a: "no" }, { provider: "x", slug: "acme" }), null);
});

/* ===== the connectivity gate, at the level that actually matters ===== */

// The behaviour the whole gate exists for: during an outage a board fetch must WAIT,
// not fail and let the run march on to the next company. Run 29 skipped hundreds of
// boards in an ~8-minute drop precisely because this call returned instead of waiting.
test("atsFetchJson waits out a network outage instead of failing the board", async (t) => {
  let online = false;
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ intervalMs: 5, downIntervalMs: 5, probe: async () => online });
  await new Promise((r) => setTimeout(r, 20));

  let fetchCalls = 0;
  stubFetch(t, async () => {
    fetchCalls++;
    return jsonResponse({ ok: true });
  });

  let settled = false;
  const pending = atsFetchJson("https://boards.example/jobs").then((v) => {
    settled = true;
    return v;
  });

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchCalls, 0, "must not have touched the network while it was down");
  assert.equal(settled, false, "must still be waiting, not skipped");

  online = true;
  const result = await pending;
  assert.equal(fetchCalls, 1, "resumed exactly once, after recovery");
  assert.deepEqual(result, { ok: true });
});

// A board that answers - even with a block page - proves the connection is fine, so
// one hostile host must never pause everything else.
test("a blocked board reports success to the monitor and does not pause the run", async (t) => {
  t.after(stopConnectivityMonitor);
  startConnectivityMonitor({ intervalMs: 10_000, downIntervalMs: 10_000, probe: async () => true });
  await new Promise((r) => setTimeout(r, 15));

  stubFetch(t, async () => new Response("<html>Access Denied</html>", { status: 403 }));
  await assert.rejects(atsFetchJson("https://waf.example/jobs"));

  assert.equal(connectivityStatus().down, false, "a 403 is the board's problem, not the network's");
});
