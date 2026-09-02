import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { stubFetch, jsonResponse } from "../../ats/__tests__/testHelpers.js";
import { LlmUnavailableError } from "../errors.js";
import {
  openRouterGenerate,
  openRouterEmbed,
  getCacheStats,
  resetCacheStats,
  assertModelAvailable,
  classifyOpenRouterStatus,
  refineVerdict,
} from "../openrouter.js";

const SentBodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  temperature: z.number(),
  reasoning: z.object({ enabled: z.boolean() }),
  response_format: z.object({ type: z.string() }).optional(),
});

function sentBody(init: RequestInit | undefined): z.infer<typeof SentBodySchema> {
  return SentBodySchema.parse(JSON.parse(String(init?.body)));
}

function completion(content: string, usage?: { prompt_tokens: number; cached: number }): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: usage.cached },
          },
        }
      : {}),
  });
}

function throttled(retryAfter: string): Response {
  return new Response("rate limited", { status: 429, headers: { "retry-after": retryAfter } });
}

test("openRouterGenerate unwraps choices[0].message.content", async (t) => {
  stubFetch(t, async () => completion('{"matchScore":0.9}'));
  assert.equal(await openRouterGenerate("prompt", { format: "json" }), '{"matchScore":0.9}');
});

test("openRouterGenerate sends one user message, json response_format, and the bearer key", async (t) => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  stubFetch(t, async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return completion("{}");
  });

  await openRouterGenerate("THE PROMPT", { format: "json", temperature: 0 });

  assert.match(seenUrl, /openrouter\.ai\/api\/v1\/chat\/completions/);
  const headers = new Headers(seenInit?.headers);
  // Key is unset under test, so only the "Bearer" scheme is pinned here.
  assert.match(headers.get("authorization") ?? "", /^Bearer/);
  const body = sentBody(seenInit);
  // One message keeps the token prefix byte-identical, which the provider's prompt cache keys on.
  assert.deepEqual(body.messages, [{ role: "user", content: "THE PROMPT" }]);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.reasoning.enabled, false);
  assert.equal(body.temperature, 0);
});

test("openRouterGenerate omits response_format when no json format is requested", async (t) => {
  let seenInit: RequestInit | undefined;
  stubFetch(t, async (_url, init) => {
    seenInit = init;
    return completion("plain text");
  });

  await openRouterGenerate("prompt", {});
  assert.equal(sentBody(seenInit).response_format, undefined);
});

test("openRouterGenerate retries a 429 honouring Retry-After, then succeeds", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    // "0.1" clamps to the 250ms floor to keep the test fast.
    return calls === 1 ? throttled("0.1") : completion("recovered");
  });

  const started = Date.now();
  const out = await openRouterGenerate("prompt", { format: "json" });

  assert.equal(out, "recovered");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 200, "should have waited out the Retry-After");
});

test("openRouterGenerate retries transient 5xx", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return calls < 3 ? new Response("boom", { status: 503 }) : completion("ok");
  });

  assert.equal(await openRouterGenerate("prompt", {}), "ok");
  assert.equal(calls, 3);
});

test("openRouterGenerate gives up after exhausting status retries", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return throttled("0.1");
  });

  await assert.rejects(openRouterGenerate("prompt", {}), /OpenRouter HTTP 429/);
  assert.equal(calls, 4, "1 initial + 3 retries");
});

test("openRouterGenerate throws LlmUnavailableError on 401 without retrying", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response("invalid api key", { status: 401 });
  });

  await assert.rejects(openRouterGenerate("prompt", {}), LlmUnavailableError);
  assert.equal(calls, 1, "a bad key must fail fast, not burn retries");
});

// 402 (out of credits) is fatal like a bad key: every subsequent posting would fail identically.
test("openRouterGenerate throws LlmUnavailableError on 402 (out of credits)", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 });
  });

  await assert.rejects(openRouterGenerate("prompt", {}), {
    name: "LlmUnavailableError",
    message: /credits/i,
  });
  assert.equal(calls, 1, "out of credits must fail fast, not burn retries");
});

// 403 is a moderation block on this input, not a bad key (401); must not abort the whole sweep.
test("openRouterGenerate treats 403 as a per-call failure, not a dead backend", async (t) => {
  stubFetch(t, async () => new Response('{"error":{"message":"flagged by moderation"}}', { status: 403 }));

  await assert.rejects(openRouterGenerate("prompt", {}), {
    name: "Error",
    message: /OpenRouter HTTP 403/,
  });
  assert.equal(classifyOpenRouterStatus(403), "perCall");
});

// An unresolvable model id is fatal; message must name the knob to fix.
test("openRouterGenerate throws LlmUnavailableError on 404 naming the model knob", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response('{"error":{"message":"No endpoints found"}}', { status: 404 });
  });

  await assert.rejects(openRouterGenerate("prompt", {}), {
    name: "LlmUnavailableError",
    message: /OPENROUTER_MODEL/,
  });
  assert.equal(calls, 1);
});

// The live API returns 400 (not 404) for an unknown slug, so the model case is picked out of the body.
test("openRouterGenerate treats a 400 'not a valid model ID' as fatal", async (t) => {
  stubFetch(
    t,
    async () =>
      new Response(
        '{"error":{"message":"deepseek/definitely-not-a-real-model is not a valid model ID","code":400}}',
        { status: 400 },
      ),
  );

  await assert.rejects(openRouterGenerate("prompt", {}), {
    name: "LlmUnavailableError",
    message: /OPENROUTER_MODEL/,
  });
});

// A plain 400 stays per-posting: an over-long prompt returns one too.
test("openRouterGenerate keeps an ordinary 400 per-posting", async (t) => {
  stubFetch(t, async () => new Response('{"error":{"message":"prompt is too long"}}', { status: 400 }));

  await assert.rejects(openRouterGenerate("prompt", {}), {
    name: "Error",
    message: /OpenRouter HTTP 400/,
  });
  assert.equal(refineVerdict("perCall", 400, "prompt is too long"), "perCall");
});

test("assertModelAvailable accepts a model the provider serves", async (t) => {
  stubFetch(t, async () => jsonResponse({ data: { id: "deepseek/deepseek-v4-flash-0731" } }));
  await assertModelAvailable("deepseek/deepseek-v4-flash-0731");
});

test("assertModelAvailable rejects an unknown model id before any scraping", async (t) => {
  stubFetch(t, async () => new Response('{"error":{"message":"Not Found","code":404}}', { status: 404 }));

  await assert.rejects(assertModelAvailable("deepseek/typo-not-real"), {
    name: "LlmUnavailableError",
    message: /deepseek\/typo-not-real/,
  });
});

// Only an explicit 404 is a verdict; a flaky metadata endpoint must not block a run.
test("assertModelAvailable tolerates a metadata-endpoint outage", async (t) => {
  stubFetch(t, async () => new Response("upstream error", { status: 503 }));
  await assertModelAvailable("deepseek/deepseek-v4-flash-0731");
});

test("assertModelAvailable tolerates the metadata endpoint being unreachable", async (t) => {
  stubFetch(t, async () => {
    throw new Error("fetch failed");
  });
  await assertModelAvailable("deepseek/deepseek-v4-flash-0731");
});

test("openRouterGenerate does not retry a non-retryable 4xx", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response("bad model", { status: 400 });
  });

  await assert.rejects(openRouterGenerate("prompt", {}), /OpenRouter HTTP 400/);
  assert.equal(calls, 1);
});

test("openRouterGenerate rejects an empty completion", async (t) => {
  stubFetch(t, async () => completion(""));
  await assert.rejects(openRouterGenerate("prompt", {}), /no message content/);
});

test("getCacheStats accumulates prompt and cached token counts", async (t) => {
  resetCacheStats();
  t.after(() => resetCacheStats());
  stubFetch(t, async () => completion("ok", { prompt_tokens: 4300, cached: 3400 }));

  await openRouterGenerate("prompt", {});
  await openRouterGenerate("prompt", {});

  assert.deepEqual(getCacheStats(), { calls: 2, promptTokens: 8600, cachedTokens: 6800 });
});

test("getCacheStats tolerates a response with no usage block", async (t) => {
  resetCacheStats();
  t.after(() => resetCacheStats());
  stubFetch(t, async () => completion("ok"));

  await openRouterGenerate("prompt", {});

  assert.deepEqual(getCacheStats(), { calls: 1, promptTokens: 0, cachedTokens: 0 });
});

// ---- openRouterEmbed ----

const EmbedBodySchema = z.object({ model: z.string(), input: z.string() });

function embedding(vector: number[]): Response {
  return jsonResponse({ data: [{ embedding: vector }] });
}

test("openRouterEmbed posts to /embeddings with the bearer key and unwraps data[0].embedding", async (t) => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  stubFetch(t, async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return embedding([0.4, 0.5, 0.6]);
  });

  const vector = await openRouterEmbed("some job description", "text-embedding-3-small");

  assert.match(seenUrl, /openrouter\.ai\/api\/v1\/embeddings/);
  const headers = new Headers(seenInit?.headers);
  assert.match(headers.get("authorization") ?? "", /^Bearer/);
  const body = EmbedBodySchema.parse(JSON.parse(String(seenInit?.body)));
  assert.deepEqual(body, { model: "text-embedding-3-small", input: "some job description" });
  assert.deepEqual(vector, [0.4, 0.5, 0.6]);
});

test("openRouterEmbed retries a 429 honouring Retry-After, then succeeds", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return calls === 1 ? throttled("0.1") : embedding([1, 0]);
  });

  const vector = await openRouterEmbed("prompt", "text-embedding-3-small");
  assert.deepEqual(vector, [1, 0]);
  assert.equal(calls, 2);
});

test("openRouterEmbed throws LlmUnavailableError on 401 without retrying", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return new Response("invalid api key", { status: 401 });
  });

  await assert.rejects(openRouterEmbed("prompt", "text-embedding-3-small"), LlmUnavailableError);
  assert.equal(calls, 1);
});

// The chat-completions fatalMessage names OPENROUTER_MODEL; embed calls must name OPENROUTER_EMBED_MODEL instead.
test("openRouterEmbed throws LlmUnavailableError on 404 naming OPENROUTER_EMBED_MODEL, not OPENROUTER_MODEL", async (t) => {
  stubFetch(t, async () => new Response('{"error":{"message":"No endpoints found"}}', { status: 404 }));

  await assert.rejects(openRouterEmbed("prompt", "text-embedding-3-small"), {
    name: "LlmUnavailableError",
    message: /OPENROUTER_EMBED_MODEL/,
  });
});

test("openRouterEmbed rejects a response with no embedding data", async (t) => {
  stubFetch(t, async () => jsonResponse({ data: [] }));
  await assert.rejects(openRouterEmbed("prompt", "text-embedding-3-small"), /no vector/);
});
