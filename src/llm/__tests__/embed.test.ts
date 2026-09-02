import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { stubFetch, jsonResponse } from "../../ats/__tests__/testHelpers.js";
import { config } from "../../config.js";
import { embedText, embedModelTag, cosine } from "../embed.js";

const EmbedBodySchema = z.object({ input: z.string() });

// config.llm.local defaults true (no LOCAL env set in the test run — see test-setup.mjs), so these tests
// exercise the Ollama transport branch of the shared dispatch; openrouter.test.ts/ollama.test.ts already
// pin each transport's own request shape independently.

test("embedModelTag / embedText return null when the active backend's embed-model knob is unset", async (t) => {
  assert.equal(config.llm.local, true, "test assumes LOCAL default (true)");
  assert.equal(config.llm.ollamaEmbedModel, undefined, "test assumes OLLAMA_EMBED_MODEL is unset in the test env");

  let fetchCalled = false;
  stubFetch(t, async () => {
    fetchCalled = true;
    return jsonResponse({ embeddings: [[1, 2, 3]] });
  });

  assert.equal(embedModelTag(), null);
  assert.equal(await embedText("some text"), null);
  assert.equal(fetchCalled, false, "the knob being unset must skip the transport call entirely");
});

test("embedText dispatches to Ollama and tags the result ollama:<model>", async (t) => {
  const original = config.llm.ollamaEmbedModel;
  Object.defineProperty(config.llm, "ollamaEmbedModel", { value: "nomic-embed-text", configurable: true });
  t.after(() => {
    Object.defineProperty(config.llm, "ollamaEmbedModel", { value: original, configurable: true });
  });

  let seenUrl = "";
  stubFetch(t, async (url) => {
    seenUrl = String(url);
    return jsonResponse({ embeddings: [[0.1, 0.2]] });
  });

  assert.equal(embedModelTag(), "ollama:nomic-embed-text");
  const result = await embedText("some job description");
  assert.match(seenUrl, /\/api\/embed$/);
  assert.deepEqual(result, { vector: [0.1, 0.2], modelTag: "ollama:nomic-embed-text" });
});

test("embedText truncates input to 8000 chars before sending", async (t) => {
  const original = config.llm.ollamaEmbedModel;
  Object.defineProperty(config.llm, "ollamaEmbedModel", { value: "nomic-embed-text", configurable: true });
  t.after(() => {
    Object.defineProperty(config.llm, "ollamaEmbedModel", { value: original, configurable: true });
  });

  let seenInput = "";
  stubFetch(t, async (_url, init) => {
    seenInput = EmbedBodySchema.parse(JSON.parse(String(init?.body))).input;
    return jsonResponse({ embeddings: [[0.1]] });
  });

  await embedText("x".repeat(9000));
  assert.equal(seenInput.length, 8000);
});

test("embedText returns null and warns (never throws) on a transport error — shadow mode never fails a posting", async (t) => {
  const original = config.llm.ollamaEmbedModel;
  Object.defineProperty(config.llm, "ollamaEmbedModel", { value: "nomic-embed-text", configurable: true });
  t.after(() => {
    Object.defineProperty(config.llm, "ollamaEmbedModel", { value: original, configurable: true });
  });

  stubFetch(t, async () => new Response("boom", { status: 500 }));

  await assert.doesNotReject(async () => {
    const result = await embedText("some text");
    assert.equal(result, null);
  });
});

test("cosine: identical vectors score 1, orthogonal vectors score 0", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test("cosine: opposite vectors score -1", () => {
  assert.equal(cosine([1, 0], [-1, 0]), -1);
});

test("cosine: a dimension mismatch returns 0 instead of throwing", () => {
  assert.equal(cosine([1, 2, 3], [1, 2]), 0);
});

test("cosine: a zero vector returns 0 instead of NaN", () => {
  assert.equal(cosine([0, 0], [1, 1]), 0);
});
