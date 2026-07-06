// src/google/sheets.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { readTab, appendRows, rewriteTab, listTabs, ensureTabs, updateRange } from "./sheets.js";
import { __resetTokenCacheForTests } from "./auth.js";

const BatchUpdateRequestSchema = z.object({
  requests: z.array(z.object({ addSheet: z.object({ properties: z.object({ title: z.string() }) }) })),
});

const ENV_BACKUP = { ...process.env };

function setEnv(): void {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_SPREADSHEET_ID = "sheet-123";
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

// getAccessToken() with no injected deps reads real files off disk, which the
// repo law forbids in tests. Sheets tests therefore need a token deps stand-in
// too; sheets.ts accepts an optional authDeps override for exactly this.
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
}

/** noUncheckedIndexedAccess-safe array access for test assertions. */
function nth<T>(arr: T[], i: number): T {
  const v = arr[i];
  assert.ok(v !== undefined, `expected element at index ${i}`);
  return v;
}

function stubFetchSequence(responses: Array<() => Response>): { fetchFn: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const make = nth(responses, Math.min(i, responses.length - 1));
    i++;
    return make();
  };
  return { fetchFn, calls };
}

test("readTab: GET values, majorDimension=ROWS, coerces cells to strings", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({ range: "Sheet1!A1:Z999", majorDimension: "ROWS", values: [["a", 1, true]] }), { status: 200 }),
  ]);
  const rows = await readTab("testprofile", "Raw Data", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(rows, [["a", "1", "true"]]);
  assert.equal(calls.length, 1);
  const call = nth(calls, 0);
  assert.equal(call.method, "GET");
  assert.match(call.url, /\/values\/Raw%20Data\?majorDimension=ROWS/);
  assert.match(call.url, /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/sheet-123/);
});

test("readTab: absent values field returns []", async () => {
  const { fetchFn } = stubFetchSequence([() => new Response(JSON.stringify({ range: "Sheet1!A1:Z999" }), { status: 200 })]);
  const rows = await readTab("testprofile", "Raw Data", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(rows, []);
});

test("appendRows: POSTs to :append with valueInputOption=RAW and the rows body", async () => {
  const { fetchFn, calls } = stubFetchSequence([() => new Response(JSON.stringify({}), { status: 200 })]);
  await appendRows("testprofile", "Drafts", [["x", "y"]], { fetchFn, authDeps: fakeAuthDeps() });
  assert.equal(calls.length, 1);
  const call = nth(calls, 0);
  assert.equal(call.method, "POST");
  assert.match(call.url, /:append\?valueInputOption=RAW/);
  assert.ok(call.body);
  assert.deepEqual(JSON.parse(call.body ?? "{}"), { values: [["x", "y"]] });
});

test("rewriteTab: clears then PUTs header+rows to A1 with valueInputOption=RAW", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({}), { status: 200 }),
    () => new Response(JSON.stringify({}), { status: 200 }),
  ]);
  await rewriteTab("testprofile", "Companies", ["Name", "Status"], [["Acme", "active"]], { fetchFn, authDeps: fakeAuthDeps() });
  assert.equal(calls.length, 2);
  const clearCall = nth(calls, 0);
  const writeCall = nth(calls, 1);
  assert.match(clearCall.url, /:clear$/);
  assert.equal(clearCall.method, "POST");
  assert.match(writeCall.url, /!A1\?valueInputOption=RAW/);
  assert.equal(writeCall.method, "PUT");
  assert.deepEqual(JSON.parse(writeCall.body ?? "{}"), { values: [["Name", "Status"], ["Acme", "active"]] });
});

test("listTabs: GET with fields=sheets.properties.title, returns titles", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({ sheets: [{ properties: { title: "Raw Data" } }, { properties: { title: "Drafts" } }] }), { status: 200 }),
  ]);
  const tabs = await listTabs("testprofile", { fetchFn, authDeps: fakeAuthDeps() });
  assert.deepEqual(tabs, ["Raw Data", "Drafts"]);
  assert.match(nth(calls, 0).url, /\?fields=sheets\.properties\.title/);
});

test("ensureTabs: no-op batchUpdate call when all tabs already exist", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({ sheets: [{ properties: { title: "Drafts" } }] }), { status: 200 }),
  ]);
  await ensureTabs("testprofile", ["Drafts"], { fetchFn, authDeps: fakeAuthDeps() });
  assert.equal(calls.length, 1, "only the listTabs call, no batchUpdate");
});

test("ensureTabs: batchUpdate adds only the missing tabs", async () => {
  const { fetchFn, calls } = stubFetchSequence([
    () => new Response(JSON.stringify({ sheets: [{ properties: { title: "Drafts" } }] }), { status: 200 }),
    () => new Response(JSON.stringify({}), { status: 200 }),
  ]);
  await ensureTabs("testprofile", ["Drafts", "Sent", "Undrafted"], { fetchFn, authDeps: fakeAuthDeps() });
  assert.equal(calls.length, 2);
  const batchCall = nth(calls, 1);
  assert.match(batchCall.url, /:batchUpdate$/);
  const parsed = BatchUpdateRequestSchema.parse(JSON.parse(batchCall.body ?? "{}"));
  const titles = parsed.requests.map((r) => r.addSheet.properties.title);
  assert.deepEqual(titles, ["Sent", "Undrafted"]);
});

test("updateRange: PUT to the given A1 range with valueInputOption=RAW", async () => {
  const { fetchFn, calls } = stubFetchSequence([() => new Response(JSON.stringify({}), { status: 200 })]);
  await updateRange("testprofile", "Companies!B2:C2", [["foo", "bar"]], { fetchFn, authDeps: fakeAuthDeps() });
  assert.equal(calls.length, 1);
  const call = nth(calls, 0);
  assert.equal(call.method, "PUT");
  assert.match(call.url, /Companies!B2:C2\?valueInputOption=RAW/);
  assert.deepEqual(JSON.parse(call.body ?? "{}"), { values: [["foo", "bar"]] });
});

test("retries once on 429 then succeeds", async () => {
  let attempt = 0;
  const fetchFn: typeof fetch = async () => {
    attempt++;
    if (attempt === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ values: [["ok"]] }), { status: 200 });
  };
  const rows = await readTab("testprofile", "Raw Data", { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 });
  assert.deepEqual(rows, [["ok"]]);
  assert.equal(attempt, 2);
});

test("retries once on 500 then succeeds", async () => {
  let attempt = 0;
  const fetchFn: typeof fetch = async () => {
    attempt++;
    if (attempt === 1) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ values: [] }), { status: 200 });
  };
  const rows = await readTab("testprofile", "Raw Data", { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 });
  assert.deepEqual(rows, []);
  assert.equal(attempt, 2);
});

test("throws after a second consecutive failure (no infinite retry)", async () => {
  let attempt = 0;
  const fetchFn: typeof fetch = async () => {
    attempt++;
    return new Response("still broken", { status: 500 });
  };
  await assert.rejects(
    readTab("testprofile", "Raw Data", { fetchFn, authDeps: fakeAuthDeps(), retryDelayMs: 1 }),
    /500/,
  );
  assert.equal(attempt, 2);
});

test("missing spreadsheet id gives a clear error", async () => {
  delete process.env.GOOGLE_SPREADSHEET_ID;
  const { fetchFn } = stubFetchSequence([() => new Response(JSON.stringify({ values: [] }), { status: 200 })]);
  await assert.rejects(readTab("testprofile", "Raw Data", { fetchFn, authDeps: fakeAuthDeps() }), /GOOGLE_SPREADSHEET_ID/);
});
