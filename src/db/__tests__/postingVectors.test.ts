import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertPostingVector, getPostingVector, floatsToBlob, blobToFloats } from "../postingVectors.js";

// float32 has ~7 significant decimal digits; this bound catches a broken roundtrip without being brittle
// to the last bit of float32 rounding.
const EPSILON = 1e-6;

function assertCloseVector(actual: number[], expected: number[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => {
    assert.ok(Math.abs(v - (expected[i] ?? 0)) < EPSILON, `index ${i}: ${v} !~= ${expected[i]}`);
  });
}

test("floatsToBlob / blobToFloats roundtrip exactly (within float32 epsilon)", () => {
  const original = [0.1, -0.25, 3.5, 0, 1, -1, 0.123456789];
  const blob = floatsToBlob(original);
  assert.ok(blob instanceof Uint8Array);
  assert.equal(blob.byteLength, original.length * 4);
  assertCloseVector(blobToFloats(blob), original);
});

test("floatsToBlob / blobToFloats roundtrip an empty vector", () => {
  assert.deepEqual(blobToFloats(floatsToBlob([])), []);
});

test("upsertPostingVector stores a vector retrievable by getPostingVector", () => {
  const id = `pv-${Date.now()}`;
  const vector = [0.5, -0.5, 0.25, 0.75];
  upsertPostingVector({
    provider: "custom",
    externalId: id,
    profileId: "pX",
    modelTag: "ollama:nomic-embed-text",
    vector,
  });

  const row = getPostingVector("custom", id, "pX", "ollama:nomic-embed-text");
  assert.ok(row);
  assert.equal(row.dims, 4);
  assertCloseVector(row.vector, vector);
});

test("getPostingVector returns undefined for an unknown key", () => {
  assert.equal(getPostingVector("custom", "does-not-exist", "pX", "ollama:nomic-embed-text"), undefined);
});

test("upsertPostingVector replaces an existing row for the same (provider, external_id, profile_id, model_tag)", () => {
  const id = `pv-replace-${Date.now()}`;
  upsertPostingVector({
    provider: "custom",
    externalId: id,
    profileId: "pX",
    modelTag: "ollama:nomic-embed-text",
    vector: [1, 1, 1],
  });
  upsertPostingVector({
    provider: "custom",
    externalId: id,
    profileId: "pX",
    modelTag: "ollama:nomic-embed-text",
    vector: [2, 2],
  });

  const row = getPostingVector("custom", id, "pX", "ollama:nomic-embed-text");
  assert.ok(row);
  assert.equal(row.dims, 2);
  assertCloseVector(row.vector, [2, 2]);
});

test("different model tags for the same posting/profile are stored as separate rows", () => {
  const id = `pv-multitag-${Date.now()}`;
  upsertPostingVector({ provider: "custom", externalId: id, profileId: "pX", modelTag: "ollama:a", vector: [1] });
  upsertPostingVector({ provider: "custom", externalId: id, profileId: "pX", modelTag: "openrouter:b", vector: [2] });

  assertCloseVector(getPostingVector("custom", id, "pX", "ollama:a")?.vector ?? [], [1]);
  assertCloseVector(getPostingVector("custom", id, "pX", "openrouter:b")?.vector ?? [], [2]);
});
