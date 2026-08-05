// src/google/rest.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { googleFetchJson } from "../rest.js";
import { __resetTokenCacheForTests } from "../auth.js";
import type { GoogleAuthDeps } from "../auth.js";

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ENV_BACKUP);
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  __resetTokenCacheForTests();
});

function fakeAuthDeps(): GoogleAuthDeps {
  const token = { refresh_token: "rt-1", access_token: "at-fresh", expiry: Date.now() + 60 * 60 * 1000 };
  return {
    fetchFn: async () => {
      throw new Error("auth fetch should not be called for a fresh token");
    },
    tokenPath: "data/google-token-testprofile.json",
    readFile: () => JSON.stringify(token),
    existsSync: () => true,
    writeFileAtomic: () => {
      throw new Error("should not rewrite a fresh token");
    },
    now: () => Date.now(),
  };
}

function sequenceFetch(responses: Response[]): { fetchFn: typeof fetch; calls: () => number } {
  let i = 0;
  const fetchFn: typeof fetch = async () => {
    const res = responses[i];
    i++;
    if (!res) throw new Error(`fetch called ${i} times but only ${responses.length} responses queued`);
    return res;
  };
  return { fetchFn, calls: () => i };
}

test("googleFetchJson retries a GET once on 500", async () => {
  const { fetchFn, calls } = sequenceFetch([
    new Response("boom", { status: 500 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]);
  const out = await googleFetchJson("testprofile", "https://api/x", {}, { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls(), 2);
});

test("googleFetchJson does NOT retry a POST on 500 (may have been processed — a replay would duplicate the draft/row)", async () => {
  const { fetchFn, calls } = sequenceFetch([new Response("boom", { status: 500 })]);
  await assert.rejects(
    () =>
      googleFetchJson(
        "testprofile",
        "https://api/x",
        { method: "POST", body: { a: 1 } },
        { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 },
      ),
    /Google API 500/,
  );
  assert.equal(calls(), 1);
});

test("googleFetchJson retries a POST once on 429 (rate-limited = rejected before processing)", async () => {
  const { fetchFn, calls } = sequenceFetch([
    new Response("slow down", { status: 429 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]);
  const out = await googleFetchJson(
    "testprofile",
    "https://api/x",
    { method: "POST", body: { a: 1 } },
    { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 },
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(calls(), 2);
});
