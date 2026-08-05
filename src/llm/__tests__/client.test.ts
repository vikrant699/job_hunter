import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../../config.js";
import { isConnectionError, OllamaUnavailableError, assertOllamaAvailable, generateOnce } from "../client.js";

test("isConnectionError flags backend-down signatures", () => {
  for (const e of [
    "TypeError: fetch failed",
    new Error("connect ECONNREFUSED 127.0.0.1:11434"),
    "getaddrinfo ENOTFOUND localhost",
    "read ECONNRESET",
    "socket hang up",
    "The operation was aborted",
    "network error",
  ]) {
    assert.equal(isConnectionError(e), true, `expected connection error: ${String(e)}`);
  }
});

test("isConnectionError does NOT flag model/output errors", () => {
  for (const e of [
    "Ollama HTTP 500: internal error",
    "Ollama returned no 'response' field",
    "ZodError: matchScore Required",
    "SyntaxError: Unexpected token",
  ]) {
    assert.equal(isConnectionError(e), false, `should be recoverable: ${String(e)}`);
  }
});

const realFetch = globalThis.fetch;
function stubFetch(fn: typeof globalThis.fetch): void {
  globalThis.fetch = fn;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test("assertOllamaAvailable passes when the configured model is present", async () => {
  stubFetch(async () =>
    new Response(JSON.stringify({ models: [{ name: config.llm.model }, { name: "other:1b" }] }), { status: 200 }),
  );
  try {
    await assert.doesNotReject(assertOllamaAvailable());
  } finally {
    restoreFetch();
  }
});

test("assertOllamaAvailable throws when Ollama is unreachable", async () => {
  stubFetch(async () => { throw new TypeError("fetch failed"); });
  try {
    await assert.rejects(assertOllamaAvailable(), OllamaUnavailableError);
  } finally {
    restoreFetch();
  }
});

test("assertOllamaAvailable throws when the model is not pulled", async () => {
  stubFetch(async () =>
    new Response(JSON.stringify({ models: [{ name: "some-other-model:7b" }] }), { status: 200 }),
  );
  try {
    await assert.rejects(assertOllamaAvailable(), OllamaUnavailableError);
  } finally {
    restoreFetch();
  }
});

test("generateOnce makes exactly one HTTP call and returns the response on success", async () => {
  let calls = 0;
  stubFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
  });
  try {
    const out = await generateOnce("prompt");
    assert.equal(out, "ok");
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

test("generateOnce does not retry on failure (single attempt only)", async () => {
  let calls = 0;
  stubFetch(async () => {
    calls++;
    throw new TypeError("fetch failed");
  });
  try {
    await assert.rejects(generateOnce("prompt"));
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});
