import { test } from "node:test";
import assert from "node:assert/strict";
import { probeWithTimeout } from "./probe.js";

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("probeWithTimeout returns status, body, finalUrl, ok on a normal 200", async () => {
  stubFetch(async () => new Response("hello", { status: 200 }));
  try {
    const r = await probeWithTimeout("https://example.com/x");
    assert.equal(r.status, 200);
    assert.equal(r.body, "hello");
    assert.equal(r.finalUrl, "https://example.com/x");
    assert.equal(r.ok, true);
  } finally {
    restoreFetch();
  }
});

test("probeWithTimeout reports ok:false with the status for a non-2xx response", async () => {
  stubFetch(async () => new Response("nope", { status: 404 }));
  try {
    const r = await probeWithTimeout("https://example.com/missing");
    assert.equal(r.status, 404);
    assert.equal(r.ok, false);
    assert.equal(r.body, "nope");
  } finally {
    restoreFetch();
  }
});

test("probeWithTimeout collapses network errors to status 0 / ok false, never throws", async () => {
  stubFetch(async () => { throw new TypeError("fetch failed"); });
  try {
    const r = await probeWithTimeout("https://example.com/down");
    assert.equal(r.status, 0);
    assert.equal(r.ok, false);
    assert.equal(r.body, "");
    assert.equal(r.finalUrl, "https://example.com/down");
  } finally {
    restoreFetch();
  }
});

test("probeWithTimeout passes through method, headers, and body", async () => {
  let seenInit: RequestInit | undefined;
  stubFetch(async (_input, init) => {
    seenInit = init;
    return new Response("{}", { status: 200 });
  });
  try {
    await probeWithTimeout("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(seenInit?.method, "POST");
    assert.equal(new Headers(seenInit?.headers).get("Content-Type"), "application/json");
    assert.equal(seenInit?.body, JSON.stringify({ a: 1 }));
  } finally {
    restoreFetch();
  }
});
