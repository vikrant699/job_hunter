// src/ats/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATS_ADAPTERS } from "./registry.js";

test("every ATS_ADAPTERS key matches its adapter's provider string", () => {
  // The registry key routes companies to the adapter, and adapter.provider is
  // stamped on every posting row — a mismatch would silently store postings
  // under a provider that never resolves back to the adapter.
  const mismatched = Object.entries(ATS_ADAPTERS)
    .filter(([key, adapter]) => adapter.provider !== key)
    .map(([key, adapter]) => `${key} -> ${adapter.provider}`);
  assert.deepEqual(mismatched, []);
});
