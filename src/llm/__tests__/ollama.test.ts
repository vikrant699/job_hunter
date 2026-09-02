import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { stubFetch, jsonResponse } from "../../ats/__tests__/testHelpers.js";
import { ollamaEmbed } from "../ollama.js";

const EmbedBodySchema = z.object({ model: z.string(), input: z.string() });

test("ollamaEmbed sends {model, input} and unwraps embeddings[0]", async (t) => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  stubFetch(t, async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonResponse({ embeddings: [[0.1, 0.2, 0.3]] });
  });

  const vector = await ollamaEmbed("some job description", "nomic-embed-text");

  assert.match(seenUrl, /\/api\/embed$/);
  const body = EmbedBodySchema.parse(JSON.parse(String(seenInit?.body)));
  assert.deepEqual(body, { model: "nomic-embed-text", input: "some job description" });
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
});

test("ollamaEmbed throws on a non-2xx response", async (t) => {
  stubFetch(t, async () => new Response("boom", { status: 500 }));
  await assert.rejects(ollamaEmbed("x", "nomic-embed-text"), /Ollama embed HTTP 500/);
});

test("ollamaEmbed throws when the response has no embeddings array entry", async (t) => {
  stubFetch(t, async () => jsonResponse({ embeddings: [] }));
  await assert.rejects(ollamaEmbed("x", "nomic-embed-text"), /no vector/);
});

test("ollamaEmbed throws on a malformed response body (zod validation)", async (t) => {
  stubFetch(t, async () => jsonResponse({ nope: true }));
  await assert.rejects(ollamaEmbed("x", "nomic-embed-text"));
});
