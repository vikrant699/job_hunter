import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { insertOutreach, updateOutreachStatus } from "../db/outreach.js";
import { insertUndrafted } from "../db/outreach.js";
import { DRAFTS_HEADER, SENT_HEADER, UNDRAFTED_HEADER } from "./tabs.js";
import { projectToSheet, type SheetSyncDeps } from "./sheet-sync.js";

function mkEmail(tag: string): string {
  return `sheetsync-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function baseRow(overrides: Partial<Parameters<typeof insertOutreach>[0]> = {}): Parameters<typeof insertOutreach>[0] {
  return {
    profileId: "default",
    recruiterEmail: mkEmail("row"),
    companyName: "Acme",
    rolesJson: JSON.stringify([{ title: "Data Analyst", jobUrl: "https://acme.com/1", severity: "green", score: 0.9 }]),
    runId: null,
    runDate: "2026-07-06",
    gmailDraftId: "draft-1",
    gmailThreadId: "thread-1",
    gmailMessageId: "msg-1",
    status: "draft",
    draftedAt: new Date().toISOString(),
    sentAt: null,
    verifiedAt: null,
    lastCheckedAt: null,
    failureDetail: null,
    ...overrides,
  };
}

interface Harness {
  deps: SheetSyncDeps;
  rewrites: Array<{ tab: string; header: string[]; rows: string[][] }>;
  appends: Array<{ tab: string; rows: string[][] }>;
}

function harness(): Harness {
  const rewrites: Array<{ tab: string; header: string[]; rows: string[][] }> = [];
  const appends: Array<{ tab: string; rows: string[][] }> = [];
  const deps: SheetSyncDeps = {
    rewriteTab: async (profileId: string, tab: string, header: string[], rows: string[][]) => {
      rewrites.push({ tab, header, rows });
    },
    appendRows: async (profileId: string, tab: string, rows: string[][]) => {
      appends.push({ tab, rows });
    },
  };
  return { deps, rewrites, appends };
}

test("projectToSheet writes the Drafts tab with all draft-status rows across profiles", async () => {
  const { deps, rewrites } = harness();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const emailA = mkEmail(`drafts-a-${tag}`);
  const emailB = mkEmail(`drafts-b-${tag}`);
  insertOutreach(baseRow({
    recruiterEmail: emailA,
    profileId: `sheetsync-p1-${tag}`,
    companyName: `DraftCo-${tag}`,
    rolesJson: JSON.stringify([
      { title: "Data Analyst", jobUrl: "https://acme.com/1", severity: "green", score: 0.9 },
      { title: "BI Engineer", jobUrl: "https://acme.com/2", severity: "yellow", score: 0.95 },
    ]),
  }));
  insertOutreach(baseRow({
    recruiterEmail: emailB,
    profileId: `sheetsync-p2-${tag}`,
    companyName: `DraftCo2-${tag}`,
    status: "sent", // must NOT appear in Drafts tab
  }));

  await projectToSheet("default", deps);

  const draftsWrite = rewrites.find((r) => r.tab === config.google.tabs.drafts);
  assert.ok(draftsWrite);
  assert.deepEqual(draftsWrite.header, [...DRAFTS_HEADER]);
  const row = draftsWrite.rows.find((r) => r[6] === emailA);
  assert.ok(row);
  assert.equal(row[2], `DraftCo-${tag}`); // Company
  assert.equal(row[3], "Data Analyst — https://acme.com/1\nBI Engineer — https://acme.com/2"); // Roles
  // Max-severity: green beats yellow even though yellow scored higher.
  assert.equal(row[4], "green"); // Severity
  assert.equal(row[5], "0.9"); // Score

  assert.ok(!draftsWrite.rows.some((r) => r[6] === emailB));
});

test("projectToSheet: Drafts severity/score picks highest score within the same max severity", async () => {
  const { deps, rewrites } = harness();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = mkEmail(`drafts-tie-${tag}`);
  insertOutreach(baseRow({
    recruiterEmail: email,
    companyName: `TieCo-${tag}`,
    rolesJson: JSON.stringify([
      { title: "Role A", jobUrl: "https://x/a", severity: "green", score: 0.7 },
      { title: "Role B", jobUrl: "https://x/b", severity: "green", score: 0.95 },
    ]),
  }));

  await projectToSheet("default", deps);

  const draftsWrite = rewrites.find((r) => r.tab === config.google.tabs.drafts);
  assert.ok(draftsWrite);
  const row = draftsWrite.rows.find((r) => r[6] === email);
  assert.ok(row);
  assert.equal(row[4], "green");
  assert.equal(row[5], "0.95");
});

test("projectToSheet writes the Sent tab with sent/bounced/verified rows, newest first, raw status, computed Check After", async () => {
  const { deps, rewrites } = harness();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = mkEmail(`sent-${tag}`);
  const sentAt = new Date("2026-07-01T00:00:00.000Z").toISOString();
  const id = insertOutreach(baseRow({ recruiterEmail: email, companyName: `SentCo-${tag}`, status: "sent" }));
  updateOutreachStatus({ id, status: "sent", sentAt });

  await projectToSheet("default", deps);

  const sentWrite = rewrites.find((r) => r.tab === config.google.tabs.sent);
  assert.ok(sentWrite);
  assert.deepEqual(sentWrite.header, [...SENT_HEADER]);
  const row = sentWrite.rows.find((r) => r[4] === email);
  assert.ok(row);
  assert.equal(row[2], `SentCo-${tag}`); // Company
  assert.equal(row[5], sentAt); // Sent At
  assert.equal(row[6], new Date(new Date(sentAt).getTime() + config.outreach.verifyAfterHours * 3_600_000).toISOString()); // Check After
  assert.equal(row[7], "sent"); // Status: raw status, not a pending/verified check-relabel
});

test("projectToSheet appends Undrafted rows for the current IST run date only, never rewrites", async () => {
  const { deps, appends, rewrites } = harness();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const runDate = "2026-07-06";
  insertUndrafted({
    profileId: "default",
    runId: null,
    runDate,
    company: `UndraftedCo-${tag}`,
    jobTitle: "Analyst",
    location: "Remote",
    jobUrl: "https://x/undrafted",
    severity: "yellow",
    score: 0.5,
    reason: "no_contact",
  });

  await projectToSheet("default", deps, runDate);

  assert.ok(!rewrites.some((r) => r.tab === config.google.tabs.undrafted));
  const undraftedAppend = appends.find((a) => a.tab === config.google.tabs.undrafted);
  assert.ok(undraftedAppend);
  const row = undraftedAppend.rows.find((r) => r[2] === `UndraftedCo-${tag}`);
  assert.ok(row);
  assert.equal(row[0], runDate);
  assert.equal(row[3], "Analyst");
  assert.equal(row[8], "no_contact");
});

test("UNDRAFTED_HEADER shape sanity (guards column-index assumptions in this test file)", () => {
  assert.deepEqual(
    [...UNDRAFTED_HEADER],
    ["Run Date", "Profile", "Company", "Role", "Location", "Job URL", "Severity", "Score", "Reason"],
  );
});
