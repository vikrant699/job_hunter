import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertOutreach,
  selectOutreachByStatus,
  updateOutreachStatus,
  selectLastDraftedAt,
  insertUndrafted,
  selectUndraftedByRun,
  selectUndraftedByRunDate,
  selectOutreachSentTab,
} from "./outreach.js";

function mkEmail(tag: string): string {
  return `outreach-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function baseRow(overrides: Partial<Parameters<typeof insertOutreach>[0]> = {}): Parameters<typeof insertOutreach>[0] {
  return {
    profileId: "default",
    recruiterEmail: mkEmail("row"),
    companyName: "Acme",
    rolesJson: JSON.stringify([{ title: "Data Analyst", jobUrl: "https://x/y", severity: "green", score: 0.9 }]),
    runId: null,
    runDate: "2026-07-06",
    gmailDraftId: null,
    gmailThreadId: null,
    gmailMessageId: null,
    status: "draft",
    draftedAt: new Date().toISOString(),
    sentAt: null,
    verifiedAt: null,
    lastCheckedAt: null,
    failureDetail: null,
    ...overrides,
  };
}

test("insertOutreach returns an id and the row is retrievable by status", () => {
  const email = mkEmail("insert");
  const id = insertOutreach(baseRow({ recruiterEmail: email, status: "draft" }));
  assert.equal(typeof id, "number");
  const drafts = selectOutreachByStatus("draft");
  assert.ok(drafts.some((r) => r.id === id && r.recruiterEmail === email));
});

test("selectOutreachByStatus filters by profileId when given", () => {
  const emailA = mkEmail("profile-a");
  const emailB = mkEmail("profile-b");
  const idA = insertOutreach(baseRow({ recruiterEmail: emailA, profileId: "alice", status: "sent" }));
  const idB = insertOutreach(baseRow({ recruiterEmail: emailB, profileId: "bob", status: "sent" }));

  const aliceRows = selectOutreachByStatus("sent", "alice");
  assert.ok(aliceRows.some((r) => r.id === idA));
  assert.ok(!aliceRows.some((r) => r.id === idB));
});

test("updateOutreachStatus patches only provided fields", () => {
  const id = insertOutreach(baseRow({ status: "draft" }));
  const sentAt = new Date().toISOString();
  updateOutreachStatus({ id, status: "sent", sentAt });

  const rows = selectOutreachByStatus("sent");
  const row = rows.find((r) => r.id === id);
  assert.ok(row);
  assert.equal(row.status, "sent");
  assert.equal(row.sentAt, sentAt);
  assert.equal(row.verifiedAt, null);
  assert.equal(row.failureDetail, null);

  // Second patch: only verifiedAt provided, sentAt must be preserved untouched.
  const verifiedAt = new Date().toISOString();
  updateOutreachStatus({ id, status: "verified", verifiedAt });
  const rows2 = selectOutreachByStatus("verified");
  const row2 = rows2.find((r) => r.id === id);
  assert.ok(row2);
  assert.equal(row2.sentAt, sentAt);
  assert.equal(row2.verifiedAt, verifiedAt);
});

test("updateOutreachStatus can set failureDetail and lastCheckedAt independently", () => {
  const id = insertOutreach(baseRow({ status: "sent" }));
  const lastCheckedAt = new Date().toISOString();
  updateOutreachStatus({ id, status: "bounced", lastCheckedAt, failureDetail: "mailer-daemon" });
  const rows = selectOutreachByStatus("bounced");
  const row = rows.find((r) => r.id === id);
  assert.ok(row);
  assert.equal(row.lastCheckedAt, lastCheckedAt);
  assert.equal(row.failureDetail, "mailer-daemon");
});

test("selectLastDraftedAt returns MAX(drafted_at) across multiple rows, scoped to profile", () => {
  const email = mkEmail("cooldown");
  const older = new Date(Date.now() - 10_000).toISOString();
  const newer = new Date().toISOString();
  insertOutreach(baseRow({ recruiterEmail: email, profileId: "p1", draftedAt: older, status: "sent" }));
  insertOutreach(baseRow({ recruiterEmail: email, profileId: "p1", draftedAt: newer, status: "draft" }));
  // different profile, should not affect p1's result
  insertOutreach(baseRow({ recruiterEmail: email, profileId: "p2", draftedAt: new Date(Date.now() + 50_000).toISOString(), status: "draft" }));

  const last = selectLastDraftedAt(email, "p1");
  assert.equal(last, newer);
});

test("selectLastDraftedAt returns null when no rows exist for the recruiter/profile", () => {
  const email = mkEmail("none");
  const last = selectLastDraftedAt(email, "default");
  assert.equal(last, null);
});

test("insertUndrafted + selectUndraftedByRun round-trips", () => {
  const runId = Math.floor(Date.now() % 1_000_000);
  insertUndrafted({
    profileId: "default",
    runId,
    runDate: "2026-07-06",
    company: "NoContact Inc",
    jobTitle: "Analyst",
    location: "Remote",
    jobUrl: "https://x/z",
    severity: "yellow",
    score: 0.5,
    reason: "no_contact",
  });
  const rows = selectUndraftedByRun(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.company, "NoContact Inc");
  assert.equal(rows[0]?.reason, "no_contact");
});

test("selectUndraftedByRunDate filters by run_date and profile_id", () => {
  const runDate = `2026-01-${String(1 + Math.floor(Math.random() * 27)).padStart(2, "0")}`;
  insertUndrafted({
    profileId: "profX",
    runId: null,
    runDate,
    company: "DateFilter Co",
    jobTitle: "Engineer",
    location: null,
    jobUrl: "https://x/w",
    severity: "green",
    score: null,
    reason: "cooldown",
  });
  insertUndrafted({
    profileId: "profY",
    runId: null,
    runDate,
    company: "OtherProfile Co",
    jobTitle: "Engineer",
    location: null,
    jobUrl: "https://x/v",
    severity: "green",
    score: null,
    reason: "cooldown",
  });

  const rows = selectUndraftedByRunDate(runDate, "profX");
  assert.ok(rows.some((r) => r.company === "DateFilter Co"));
  assert.ok(!rows.some((r) => r.company === "OtherProfile Co"));
});

test("selectOutreachSentTab returns sent/bounced/verified rows across all profiles, newest sent_at first", () => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const older = new Date(Date.now() - 20_000).toISOString();
  const newer = new Date(Date.now() - 5_000).toISOString();
  const newest = new Date().toISOString();

  const idDraft = insertOutreach(baseRow({ recruiterEmail: mkEmail(`sent-tab-draft-${tag}`), status: "draft" }));
  const idSent = insertOutreach(
    baseRow({ recruiterEmail: mkEmail(`sent-tab-sent-${tag}`), status: "sent", profileId: `sent-tab-${tag}` }),
  );
  updateOutreachStatus({ id: idSent, status: "sent", sentAt: older });
  const idBounced = insertOutreach(
    baseRow({ recruiterEmail: mkEmail(`sent-tab-bounced-${tag}`), status: "bounced", profileId: `sent-tab-${tag}` }),
  );
  updateOutreachStatus({ id: idBounced, status: "bounced", sentAt: newest });
  const idVerified = insertOutreach(
    baseRow({ recruiterEmail: mkEmail(`sent-tab-verified-${tag}`), status: "verified", profileId: `sent-tab-${tag}` }),
  );
  updateOutreachStatus({ id: idVerified, status: "verified", sentAt: newer });

  const rows = selectOutreachSentTab();
  const ours = rows.filter((r) => r.id === idSent || r.id === idBounced || r.id === idVerified);
  assert.equal(ours.length, 3);
  assert.deepEqual(ours.map((r) => r.id), [idBounced, idVerified, idSent]);
  assert.ok(!rows.some((r) => r.id === idDraft));
});
