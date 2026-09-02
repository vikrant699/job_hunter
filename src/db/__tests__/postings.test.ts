import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertPostingIfNew,
  postingExists,
  updatePostingResult,
  selectNotifiedPostingsSince,
  markSeen,
  markRemoved,
  countRemovedNotifiedSince,
} from "../postings.js";
import { upsertCompany } from "../companies.js";
import { db } from "../db.js";
import { z } from "zod";
import type { NormalizedPosting } from "../../types.js";

const PostingLifecycleRowSchema = z.object({
  discovered_at: z.string(),
  last_seen_at: z.string().nullable(),
  removed_at: z.string().nullable(),
});
function lifecycleRow(provider: string, externalId: string, profileId: string) {
  const row = db
    .prepare("SELECT discovered_at, last_seen_at, removed_at FROM postings WHERE provider = ? AND external_id = ? AND profile_id = ?")
    .get(provider, externalId, profileId);
  return PostingLifecycleRowSchema.parse(row);
}
function setLastSeen(id: string, profileId: string, at: string): void {
  db.prepare("UPDATE postings SET last_seen_at = ? WHERE provider = 'custom' AND external_id = ? AND profile_id = ?").run(at, id, profileId);
}
function setRemoved(id: string, profileId: string, at: string): void {
  db.prepare("UPDATE postings SET removed_at = ? WHERE provider = 'custom' AND external_id = ? AND profile_id = ?").run(at, id, profileId);
}

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

test("selectNotifiedPostingsSince excludes a notified posting the board no longer lists (removed_at set)", () => {
  const profileId = `snps-removed-${Date.now()}`;
  const slug = `snps-removed-co-${Date.now()}`;
  const since = new Date(Date.now() - 1000).toISOString();
  const removedId = `removed-${Date.now()}`;
  const keptId = `kept-${Date.now()}`;

  insertPostingIfNew(mk(removedId, { companySlug: slug, jobTitle: "Gone Role" }), profileId);
  updatePostingResult({
    provider: "custom", externalId: removedId, profileId,
    llmRelevant: 1, llmReason: "great fit", llmConfidence: 0.9,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });
  setRemoved(removedId, profileId, new Date().toISOString());

  insertPostingIfNew(mk(keptId, { companySlug: slug, jobTitle: "Still Here Role" }), profileId);
  updatePostingResult({
    provider: "custom", externalId: keptId, profileId,
    llmRelevant: 1, llmReason: "great fit", llmConfidence: 0.9,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });

  const rows = selectNotifiedPostingsSince(since, profileId);
  assert.ok(!rows.some((r) => r.jobTitle === "Gone Role"), "a removed posting must never reach outreach");
  assert.ok(rows.some((r) => r.jobTitle === "Still Here Role"));
});

test("countRemovedNotifiedSince counts only removed rows within the notified window and profile", () => {
  const profileId = `crns-${Date.now()}`;
  const slug = `crns-co-${Date.now()}`;
  const since = new Date(Date.now() - 1000).toISOString();
  const removedId = `crns-removed-${Date.now()}`;
  const keptId = `crns-kept-${Date.now()}`;

  insertPostingIfNew(mk(removedId, { companySlug: slug }), profileId);
  updatePostingResult({
    provider: "custom", externalId: removedId, profileId,
    llmRelevant: 1, llmReason: "fit", llmConfidence: 0.9,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });
  setRemoved(removedId, profileId, new Date().toISOString());

  insertPostingIfNew(mk(keptId, { companySlug: slug }), profileId);
  updatePostingResult({
    provider: "custom", externalId: keptId, profileId,
    llmRelevant: 1, llmReason: "fit", llmConfidence: 0.9,
    yoeMin: null, yoeMax: null, dropStage: null, notifiedAt: new Date().toISOString(),
  });

  assert.equal(countRemovedNotifiedSince(since, profileId), 1);
});

test("insertPostingIfNew stamps last_seen_at equal to discovered_at on insert", () => {
  const id = `stamp-${Date.now()}`;
  const profileId = `stamp-profile-${Date.now()}`;
  insertPostingIfNew(mk(id), profileId);
  const row = lifecycleRow("custom", id, profileId);
  assert.equal(row.last_seen_at, row.discovered_at);
  assert.ok(row.last_seen_at.length > 0);
});

test("markSeen bumps last_seen_at and revives a previously removed row (clears removed_at)", () => {
  const profileId = `seen-profile-${Date.now()}`;
  const slug = `seen-co-${Date.now()}`;
  const idA = `seen-a-${Date.now()}`;
  const idB = `seen-b-${Date.now()}`;
  insertPostingIfNew(mk(idA, { companySlug: slug }), profileId);
  insertPostingIfNew(mk(idB, { companySlug: slug }), profileId);
  // Simulate idB having been marked removed by an earlier fetch.
  setRemoved(idB, profileId, new Date(Date.now() - 60000).toISOString());
  assert.ok(lifecycleRow("custom", idB, profileId).removed_at !== null);

  const seenAt = new Date().toISOString();
  markSeen("custom", slug, profileId, [idA, idB], seenAt);

  assert.equal(lifecycleRow("custom", idA, profileId).last_seen_at, seenAt);
  const b = lifecycleRow("custom", idB, profileId);
  assert.equal(b.last_seen_at, seenAt);
  assert.equal(b.removed_at, null, "a reappearing posting must be revived");
});

test("markRemoved only touches not-yet-removed rows whose last_seen_at predates the fetch, scoped to (provider, slug, profile)", () => {
  const profileId = `rm-profile-${Date.now()}`;
  const otherProfileId = `rm-other-profile-${Date.now()}`;
  const slug = `rm-co-${Date.now()}`;
  const otherSlug = `rm-other-co-${Date.now()}`;
  const staleId = `rm-stale-${Date.now()}`;
  const alreadyRemovedId = `rm-already-${Date.now()}`;
  const otherCompanyId = `rm-othercompany-${Date.now()}`;
  const otherProfileStaleId = `rm-otherprofile-${Date.now()}`;
  const freshId = `rm-fresh-${Date.now()}`;

  insertPostingIfNew(mk(staleId, { companySlug: slug }), profileId);
  insertPostingIfNew(mk(alreadyRemovedId, { companySlug: slug }), profileId);
  insertPostingIfNew(mk(otherCompanyId, { companySlug: otherSlug }), profileId);
  insertPostingIfNew(mk(otherProfileStaleId, { companySlug: slug }), otherProfileId);
  insertPostingIfNew(mk(freshId, { companySlug: slug }), profileId);

  // Explicit timestamps (rather than relying on wall-clock ordering) so the test never flakes on millisecond quantization.
  const base = Date.now();
  const stamp = (offsetMs: number): string => new Date(base + offsetMs).toISOString();

  setLastSeen(staleId, profileId, stamp(0));
  setLastSeen(otherCompanyId, profileId, stamp(0));
  setLastSeen(otherProfileStaleId, otherProfileId, stamp(0));
  setLastSeen(alreadyRemovedId, profileId, stamp(0));
  const earlierRemovedAt = stamp(-1000);
  setRemoved(alreadyRemovedId, profileId, earlierRemovedAt);
  setLastSeen(freshId, profileId, stamp(20));

  const fetchStartedAt = stamp(10);
  const removedAt = stamp(30);
  const count = markRemoved("custom", slug, profileId, fetchStartedAt, removedAt);

  assert.equal(count, 1, "only staleId qualifies");
  assert.equal(lifecycleRow("custom", staleId, profileId).removed_at, removedAt);
  assert.equal(lifecycleRow("custom", freshId, profileId).removed_at, null, "freshly (re-)seen row must survive");
  assert.equal(
    lifecycleRow("custom", alreadyRemovedId, profileId).removed_at,
    earlierRemovedAt,
    "already-removed row is left alone, not re-stamped",
  );
  assert.equal(lifecycleRow("custom", otherCompanyId, profileId).removed_at, null, "a different company_slug must not be touched");
  assert.equal(
    lifecycleRow("custom", otherProfileStaleId, otherProfileId).removed_at,
    null,
    "a different profile must not be touched",
  );
});

test("markSeen chunks IN-lists past the ~999 SQLite parameter limit (500-id chunks)", () => {
  const profileId = `chunk-profile-${Date.now()}`;
  const slug = `chunk-co-${Date.now()}`;
  const total = 501;
  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    const id = `chunk-${Date.now()}-${i}`;
    ids.push(id);
    insertPostingIfNew(mk(id, { companySlug: slug }), profileId);
  }

  const seenAt = new Date().toISOString();
  markSeen("custom", slug, profileId, ids, seenAt);

  const CountSchema = z.object({ n: z.number() });
  const row = db
    .prepare("SELECT COUNT(*) n FROM postings WHERE provider = 'custom' AND company_slug = ? AND profile_id = ? AND last_seen_at = ?")
    .get(slug, profileId, seenAt);
  assert.equal(CountSchema.parse(row).n, total, "every id across both chunks must be bumped");
});
