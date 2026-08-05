// src/ats/registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATS_ADAPTERS, resolveAdapter } from "../registry.js";
import { ProviderSchema } from "../../schemas.js";
import { llmScrapeAdapter } from "../../scraper/llmScrape.js";
import { playwrightScrapeAdapter } from "../../scraper/playwrightLlmScrape.js";
import type { Company } from "../../types.js";

test("every ATS_ADAPTERS key matches its adapter's provider string", () => {
  // The registry key routes companies to the adapter, and adapter.provider is
  // stamped on every posting row — a mismatch would silently store postings
  // under a provider that never resolves back to the adapter.
  const mismatched = Object.entries(ATS_ADAPTERS)
    .filter(([key, adapter]) => adapter.provider !== key)
    .map(([key, adapter]) => `${key} -> ${adapter.provider}`);
  assert.deepEqual(mismatched, []);
});

const documentedAbsences = ["custom"];

test("every ProviderSchema value except documented absences has an adapter", () => {
  const missing = ProviderSchema.options.filter(
    (p) => !documentedAbsences.includes(p) && !(p in ATS_ADAPTERS),
  );
  assert.deepEqual(missing, []);
});

test("every ATS_ADAPTERS key is a ProviderSchema value", () => {
  const enumValues = new Set<string>(ProviderSchema.options);
  const strays = Object.keys(ATS_ADAPTERS).filter((k) => !enumValues.has(k));
  assert.deepEqual(strays, []);
});

function companyWith(strategy: Company["parsingStrategy"], provider: Company["provider"]): Company {
  return {
    provider, slug: "acme", name: "Acme", careersUrl: "https://acme.example/careers",
    parsingStrategy: strategy, status: "active", denyReason: null, discoveredVia: null,
    tenantUrl: null, apiMeta: null, discoveredAt: "2026-01-01T00:00:00Z", lastFetchedAt: null,
    lastSuccessAt: null, lastError: null, consecutiveFailures: 0, postingsSeenTotal: 0,
    postingsMatchedTotal: 0, zeroYieldStreak: 0, urlSuspect: false,
  };
}

test("resolveAdapter routes strategies", () => {
  assert.equal(resolveAdapter(companyWith("llm-scrape", "custom")), llmScrapeAdapter);
  assert.equal(resolveAdapter(companyWith("playwright-llm-scrape", "custom")), playwrightScrapeAdapter);
  assert.equal(resolveAdapter(companyWith("ats-api", "greenhouse")), ATS_ADAPTERS["greenhouse"]);
  assert.equal(resolveAdapter(companyWith("manual", "greenhouse")), null);
  assert.equal(resolveAdapter(companyWith("ats-api", "custom")), null);
});
