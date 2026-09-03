import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { config } from "../../config.js";
import { isConnectionError, assertLlmAvailable, generateOnce, generate } from "../client.js";
import { LlmUnavailableError } from "../errors.js";
import { stubFetch, jsonResponse } from "../../ats/__tests__/testHelpers.js";

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

test("isConnectionError flags backend-down signatures", () => {
  for (const e of [
    "TypeError: fetch failed",
    new Error("connect ECONNREFUSED 104.18.2.1:443"),
    "getaddrinfo ENOTFOUND example.com",
    "read ECONNRESET",
    "socket hang up",
    "The operation was aborted",
    "network error",
  ]) {
    assert.equal(isConnectionError(e), true, `expected connection error: ${String(e)}`);
  }
});

test("isConnectionError does NOT flag model/output errors", () => {
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- a caught/thrown value is `unknown` in TS by design (Standard rule 3)
  let zodErr: unknown;
  try {
    z.string().parse(123);
  } catch (err) {
    zodErr = err;
  }
  for (const e of [
    "OpenRouter returned no message content",
    zodErr,
    new SyntaxError("Unexpected token < in JSON at position 0"),
  ]) {
    assert.equal(isConnectionError(e), false, `should be recoverable: ${String(e)}`);
  }
});

// Guards against an OpenRouter HTTP-status error being classified as connection-shaped,
// which would trip the breaker and abort a sweep over ordinary traffic shaping.
test("isConnectionError does NOT flag OpenRouter HTTP-status errors", () => {
  for (const e of [
    "OpenRouter HTTP 429: rate limit exceeded",
    "OpenRouter HTTP 500: upstream error",
    "OpenRouter HTTP 502: bad gateway",
    "OpenRouter HTTP 403: flagged by moderation",
    "OpenRouter returned no message content",
    "OpenRouter HTTP retries exhausted after 4 attempts",
  ]) {
    assert.equal(isConnectionError(e), false, `should not look backend-down: ${String(e)}`);
  }
});

test("assertLlmAvailable rejects with LlmUnavailableError when OPENROUTER_API_KEY is unset", async (t) => {
  assert.equal(config.llm.openRouterKey, "");
  // The key check must fail before any network call; a stub that throws catches a regression loudly instead of silently.
  stubFetch(t, async () => {
    throw new Error("assertLlmAvailable must not reach the network when the key is unset");
  });
  await assert.rejects(assertLlmAvailable(), LlmUnavailableError);
});

test("generateOnce makes exactly one HTTP call and returns choices[0].message.content", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return completion("hello");
  });
  const out = await generateOnce("prompt");
  assert.equal(out, "hello");
  assert.equal(calls, 1);
});

test("generateOnce does not retry a connection failure", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(generateOnce("prompt"), (err) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof LlmUnavailableError));
    return true;
  });
  assert.equal(calls, 1);

  // The failure above ticked the breaker's consecutive-failure counter (module state); a success
  // resets it so it doesn't bleed into a later test.
  globalThis.fetch = async () => completion("reset");
  await generateOnce("prompt");
});

test("generate retries a failed first attempt and returns the eventual completion", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return completion("recovered");
  });
  const out = await generate("prompt");
  assert.equal(out, "recovered");
  assert.equal(calls, 2);
});

test("generate aborts immediately on LlmUnavailableError", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response("invalid api key", { status: 401 });
  });
  await assert.rejects(generate("prompt"), LlmUnavailableError);
  assert.equal(calls, 1);
});

test("breaker trips after 5 consecutive connection failures", async (t) => {
  stubFetch(t, async () => {
    throw new TypeError("fetch failed");
  });

  for (let i = 0; i < 4; i++) {
    await assert.rejects(generateOnce("prompt"), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof LlmUnavailableError));
      return true;
    });
  }
  await assert.rejects(generateOnce("prompt"), (err) => {
    assert.ok(err instanceof LlmUnavailableError);
    assert.match(err.message, /consecutive connection failures/i);
    return true;
  });

  // A success resets the counter...
  globalThis.fetch = async () => completion("ok");
  await assert.doesNotReject(generateOnce("prompt"));

  // ...so a single failure right after does NOT immediately retrip the breaker.
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(generateOnce("prompt"), (err) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof LlmUnavailableError));
    return true;
  });

  // Leave the counter reset for whichever test runs next.
  globalThis.fetch = async () => completion("ok");
  await generateOnce("prompt");
});

test("concurrent generate calls cap at config.llm.maxConcurrent", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const pending: Array<() => void> = [];
  stubFetch(t, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => pending.push(resolve));
    inFlight--;
    return completion("ok");
  });

  const limit = config.llm.maxConcurrent;
  const total = limit + 4;
  const calls = Array.from({ length: total }, () => generateOnce("prompt"));

  const tick = () => new Promise((resolve) => setImmediate(resolve));

  let waited = 0;
  while (pending.length < limit && waited < 50) {
    await tick();
    waited++;
  }
  assert.equal(pending.length, limit);
  assert.equal(peak, limit);

  waited = 0;
  while (pending.length > 0 && waited < 50) {
    const fns = pending.splice(0);
    fns.forEach((fn) => fn());
    await tick();
    waited++;
  }

  await Promise.all(calls);
  assert.equal(peak, limit);
});
