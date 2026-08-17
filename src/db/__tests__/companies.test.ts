import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertCompany, selectActiveCompanies, selectAllCompanies, markFetchSuccess, markUrlSuspect, applyDormancy,
} from "../companies.js";
import type { CompanyStatus } from "../../schemas.js";

/** Insert a fresh company row; fresh inserts take `status` verbatim (the status-preserving CASE only fires ON CONFLICT). */
function seed(
  slug: string,
  status: CompanyStatus,
  parsingStrategy: "ats-api" | "llm-scrape" | "playwright-llm-scrape" = "ats-api",
): void {
  upsertCompany({
    provider: "custom", slug, name: `Co ${slug}`,
    careersUrl: "https://x/y", parsingStrategy, status,
    denyReason: null, discoveredVia: null, tenantUrl: null, apiMeta: null,
    discoveredAt: new Date().toISOString(),
  });
}

function statusOf(slug: string): CompanyStatus | undefined {
  return selectAllCompanies().find((c) => c.slug === slug)?.status;
}

test("selectActiveCompanies fetches active companies and skips denied/broken ones", () => {
  const tag = `sel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(`${tag}-active`, "active");
  seed(`${tag}-denied`, "denied");
  seed(`${tag}-broken`, "broken");

  const slugs = new Set(selectActiveCompanies().map((c) => c.slug));
  assert.ok(slugs.has(`${tag}-active`));
  assert.ok(!slugs.has(`${tag}-denied`));
  assert.ok(!slugs.has(`${tag}-broken`));
});

test("selectActiveCompanies rechecks a dormant company that has never been fetched", () => {
  const slug = `sel-dormant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(slug, "dormant");

  assert.ok(selectActiveCompanies().some((c) => c.slug === slug));
});

test("markFetchSuccess wakes a dormant company once it yields postings again", () => {
  const slug = `wake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(slug, "dormant");

  markFetchSuccess("custom", slug, 4);
  assert.equal(statusOf(slug), "active");
});

test("markFetchSuccess leaves a dormant company parked when it still yields nothing", () => {
  const slug = `stay-parked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(slug, "dormant");

  markFetchSuccess("custom", slug, 0);
  assert.equal(statusOf(slug), "dormant");
});

test("markFetchSuccess does not disturb a denied company that happens to yield postings", () => {
  const slug = `denied-yield-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(slug, "denied");

  markFetchSuccess("custom", slug, 9);
  assert.equal(statusOf(slug), "denied");
});

// minStreak is deliberately high so this table-wide call can't park other fixtures.
test("applyDormancy parks an active scrape company after a long zero-yield streak", () => {
  const STREAK = 7;
  const slug = `park-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(slug, "active", "llm-scrape");
  for (let i = 0; i < STREAK; i++) markFetchSuccess("custom", slug, 0);

  assert.ok(applyDormancy(STREAK) >= 1);
  assert.equal(statusOf(slug), "dormant");
});

// A suspect URL is no longer an exemption from parking; streak exceeds the test above's so neither can park the other's row.
test("applyDormancy parks url_suspect boards that have never yielded", () => {
  const STREAK = 11;
  const slug = `park-suspect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  seed(slug, "active", "playwright-llm-scrape");
  for (let i = 0; i < STREAK; i++) markFetchSuccess("custom", slug, 0);
  markUrlSuspect("custom", slug);
  assert.ok(selectAllCompanies().find((c) => c.slug === slug)?.urlSuspect, "fixture must be url_suspect");

  assert.ok(applyDormancy(STREAK) >= 1);
  assert.equal(statusOf(slug), "dormant");
});
