import { test } from "node:test";
import assert from "node:assert/strict";
import { insertPostingIfNew, postingExists, updatePostingResult, selectNotifiedPostingsSince } from "../postings.js";
import { upsertCompany } from "../companies.js";
import type { NormalizedPosting } from "../../types.js";

function mk(externalId: string, overrides: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    provider: "custom", externalId, companySlug: "acme", companyName: "Acme",
    jobTitle: "Data Analyst", jobUrl: "https://x/y", location: "Bengaluru",
    isRemote: false, jdText: "sql dashboards", postedAt: null,
    ...overrides,
  };
}

test("postingExists is per-profile: a job checked by alice is still new for bob", () => {
  const id = `iso-${Date.now()}`;
  assert.equal(insertPostingIfNew(mk(id), "alice"), true);
  assert.equal(postingExists("custom", id, "alice"), true);
  assert.equal(postingExists("custom", id, "bob"), false);
  assert.equal(insertPostingIfNew(mk(id), "bob"), true);
  assert.equal(postingExists("custom", id, "bob"), true);
});

test("insertPostingIfNew returns false for a same-profile duplicate", () => {
  const id = `dup-${Date.now()}`;
  assert.equal(insertPostingIfNew(mk(id), "pX"), true);
  assert.equal(insertPostingIfNew(mk(id), "pX"), false);
});

test("selectNotifiedPostingsSince returns notified rows since the cutoff, joined to the company display name", () => {
  const profileId = `snps-${Date.now()}`;
  const slug = `snps-co-${Date.now()}`;
  upsertCompany({
    provider: "custom", slug, name: "SNPS Display Name",
    careersUrl: "https://x", parsingStrategy: "ats-api", status: "active",
    denyReason: null, discoveredVia: null, tenantUrl: null, apiMeta: null,
    discoveredAt: new Date().toISOString(),
  });

  const since = new Date(Date.now() - 1000).toISOString();
  const greenId = `green-${Date.now()}`;
  const yellowId = `yellow-${Date.now()}`;
  const notNotifiedId = `not-notified-${Date.now()}`;

  insertPostingIfNew(mk(greenId, { companySlug: slug, jobTitle: "Green Role" }), profileId);
  updatePostingResult({
    provider: "custom", externalId: greenId, profileId,
    llmRelevant: 1, llmReason: "great fit", llmConfidence: 0.9,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });

  insertPostingIfNew(mk(yellowId, { companySlug: slug, jobTitle: "Yellow Role" }), profileId);
  updatePostingResult({
    provider: "custom", externalId: yellowId, profileId,
    llmRelevant: 0, llmReason: "borderline", llmConfidence: 0.7,
    yoeMin: null, yoeMax: null, dropStage: "yellow", notifiedAt: new Date().toISOString(),
  });

  // Not notified — must be excluded regardless of dropStage.
  insertPostingIfNew(mk(notNotifiedId, { companySlug: slug, jobTitle: "Silent Role" }), profileId);
  updatePostingResult({
    provider: "custom", externalId: notNotifiedId, profileId,
    llmRelevant: 0, llmReason: "silent", llmConfidence: 0.5,
    yoeMin: null, yoeMax: null, dropStage: "silent", notifiedAt: null,
  });

  const rows = selectNotifiedPostingsSince(since, profileId);
  assert.equal(rows.length, 2);

  const green = rows.find((r) => r.jobTitle === "Green Role");
  assert.ok(green);
  assert.equal(green.severity, "green");
  assert.equal(green.company, "SNPS Display Name");
  assert.equal(green.companySlug, slug);
  assert.equal(green.provider, "custom");
  assert.equal(green.llmConfidence, 0.9);

  const yellow = rows.find((r) => r.jobTitle === "Yellow Role");
  assert.ok(yellow);
  assert.equal(yellow.severity, "yellow");

  assert.ok(!rows.some((r) => r.jobTitle === "Silent Role"));
});

test("selectNotifiedPostingsSince scopes to profileId and falls back to slug when no company row exists", () => {
  const profileId = `snps-scope-${Date.now()}`;
  const otherProfileId = `snps-other-${Date.now()}`;
  const slug = `snps-nocompany-${Date.now()}`;
  const since = new Date(Date.now() - 1000).toISOString();
  const id = `scoped-${Date.now()}`;
  const otherId = `scoped-other-${Date.now()}`;

  insertPostingIfNew(mk(id, { companySlug: slug, jobTitle: "Scoped Role" }), profileId);
  updatePostingResult({
    provider: "custom", externalId: id, profileId,
    llmRelevant: 1, llmReason: "fit", llmConfidence: 0.95,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });

  insertPostingIfNew(mk(otherId, { companySlug: slug, jobTitle: "Other Profile Role" }), otherProfileId);
  updatePostingResult({
    provider: "custom", externalId: otherId, profileId: otherProfileId,
    llmRelevant: 1, llmReason: "fit", llmConfidence: 0.95,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });

  const rows = selectNotifiedPostingsSince(since, profileId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.company, slug);
  assert.equal(rows[0].jobTitle, "Scoped Role");
});
