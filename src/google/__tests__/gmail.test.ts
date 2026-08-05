// src/google/gmail.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createDraft, getDraft, searchMessages, getMessageMetadata } from "../gmail.js";
import { __resetTokenCacheForTests } from "../auth.js";

const DraftCreateBodySchema = z.object({ message: z.object({ raw: z.string() }) });

const ENV_BACKUP = { ...process.env };

function setEnv(): void {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ENV_BACKUP);
}

beforeEach(() => {
  restoreEnv();
  setEnv();
  __resetTokenCacheForTests();
});

function fakeAuthDeps(): {
  fetchFn: typeof fetch;
  tokenPath: string;
  readFile: (path: string) => string;
  existsSync: (path: string) => boolean;
  writeFileAtomic: (path: string, contents: string) => void;
  now: () => number;
} {
  const tokenPath = "data/google-token-testprofile.json";
  const token = { refresh_token: "rt-1", access_token: "at-fresh", expiry: Date.now() + 60 * 60 * 1000 };
  return {
    fetchFn: async () => {
      throw new Error("auth fetch should not be called for a fresh token");
    },
    tokenPath,
    readFile: () => JSON.stringify(token),
    existsSync: () => true,
    writeFileAtomic: () => {
      throw new Error("should not rewrite a fresh token");
    },
    now: () => Date.now(),
  };
}

interface CapturedRequest {
  url: string;
  method: string;
  body: string | undefined;
  authHeader: string | null;
}

function nth<T>(arr: T[], i: number): T {
  const v = arr[i];
  assert.ok(v !== undefined, `expected element at index ${i}`);
  return v;
}

function stubFetchSequence(responses: Array<() => Response>): { fetchFn: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchFn: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      authHeader: headers.get("Authorization"),
    });
    const make = nth(responses, Math.min(i, responses.length - 1));
    i++;
    return make();
  };
  return { fetchFn, calls };
}

test("createDraft: POSTs /drafts with base64url raw mime, parses ids", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () =>
      new Response(
        JSON.stringify({ id: "draft-1", message: { id: "msg-1", threadId: "thread-1" } }),
        { status: 200 },
      ),
  ]);
  const result = await createDraft("testprofile", "To: a@example.com\r\n\r\nhi", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(result, { draftId: "draft-1", messageId: "msg-1", threadId: "thread-1" });
  const call = nth(calls, 0);
  assert.equal(call.method, "POST");
  assert.match(call.url, /\/users\/me\/drafts$/);
  assert.equal(call.authHeader, "Bearer at-fresh");
  const parsed = DraftCreateBodySchema.parse(JSON.parse(call.body ?? "{}"));
  const decoded = Buffer.from(parsed.message.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  assert.equal(decoded, "To: a@example.com\r\n\r\nhi");
});

test("getDraft: 200 -> exists, 404 -> gone, other -> throws", async () => {
  {
    const { fetchFn } = stubFetchSequence([() => new Response(JSON.stringify({ id: "d1" }), { status: 200 })]);
    assert.equal(await getDraft("testprofile", "d1", { fetchFn, authDeps: fakeAuthDeps() }), "exists");
  }
  {
    const { fetchFn } = stubFetchSequence([() => new Response("not found", { status: 404 })]);
    assert.equal(await getDraft("testprofile", "d1", { fetchFn, authDeps: fakeAuthDeps() }), "gone");
  }
  {
    const { fetchFn } = stubFetchSequence([
      () => new Response("boom", { status: 500 }),
      () => new Response("boom", { status: 500 }),
    ]);
    await assert.rejects(getDraft("testprofile", "d1", { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 }));
  }
});

test("searchMessages: GET /messages?q=...&maxResults=20, absent messages -> []", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), { status: 200 }),
  ]);
  const results = await searchMessages("testprofile", "from:x@example.com", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(results, [{ id: "m1", threadId: "t1" }]);
  const call = nth(calls, 0);
  assert.match(call.url, /\/messages\?q=from%3Ax%40example\.com&maxResults=20/);
});

test("searchMessages: absent messages field returns []", async () => {
  const { fetchFn } = stubFetchSequence([() => new Response(JSON.stringify({}), { status: 200 })]);
  const results = await searchMessages("testprofile", "q", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(results, []);
});

test("getMessageMetadata: format=metadata, coerces internalDate string to number", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({ snippet: "hello there", internalDate: "1717000000000" }), { status: 200 }),
  ]);
  const meta = await getMessageMetadata("testprofile", "msg-1", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(meta, { snippet: "hello there", internalDate: 1717000000000 });
  const call = nth(calls, 0);
  assert.match(call.url, /\/messages\/msg-1\?format=metadata/);
});

test("retries once on 429 then succeeds", async () => {
  let attempt = 0;
  const fetchFn: typeof fetch = async () => {
    attempt++;
    if (attempt === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  const results = await searchMessages("testprofile", "q", { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 });
  assert.deepEqual(results, []);
  assert.equal(attempt, 2);
});
