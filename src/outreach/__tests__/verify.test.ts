import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleAuthExpiredError } from "../../google/auth.js";
import type { OutreachRow, UpdateOutreachStatusInput, InsertUndraftedInput } from "../../db/outreach.js";
import type { MessageMetadata } from "../../google/gmail.js";
import type { OutreachStatus, RecruiterStatus, RecruiterSource } from "../../schemas.js";
import { epochSeconds, runVerify, type VerifyDeps } from "../verify.js";

function mkRow(overrides: Partial<OutreachRow> = {}): OutreachRow {
  return {
    id: 1,
    profileId: "default",
    recruiterEmail: "recruiter@acme.com",
    companyName: "Acme",
    rolesJson: JSON.stringify([{ title: "Data Analyst", jobUrl: "https://acme.com/1", severity: "green", score: 0.9 }]),
    runId: 7,
    runDate: "2026-07-01",
    gmailDraftId: "draft-1",
    gmailThreadId: "thread-1",
    gmailMessageId: "msg-1",
    status: "draft",
    draftedAt: "2026-07-01T00:00:00.000Z",
    sentAt: null,
    verifiedAt: null,
    lastCheckedAt: null,
    failureDetail: null,
    ...overrides,
  };
}

interface Harness {
  deps: VerifyDeps;
  statusUpdates: UpdateOutreachStatusInput[];
  undrafted: InsertUndraftedInput[];
  recruiterStatuses: Array<{ email: string; status: RecruiterStatus; atIso: string }>;
  appended: Array<{ profileId: string; tab: string; rows: string[][] }>;
}

function harness(opts: {
  draftRows?: OutreachRow[];
  sentRows?: OutreachRow[];
  getDraft?: VerifyDeps["getDraft"];
  searchMessages?: VerifyDeps["searchMessages"];
  getMessageMetadata?: VerifyDeps["getMessageMetadata"];
  now?: () => Date;
  readTab?: VerifyDeps["readTab"];
  recruitersByEmail?: Record<string, { source: RecruiterSource; company: string; contactName: string | null; phone: string | null; registrySlug: string | null; status?: RecruiterStatus }>;
} = {}): Harness {
  const statusUpdates: UpdateOutreachStatusInput[] = [];
  const undrafted: InsertUndraftedInput[] = [];
  const recruiterStatuses: Array<{ email: string; status: RecruiterStatus; atIso: string }> = [];
  const appended: Array<{ profileId: string; tab: string; rows: string[][] }> = [];

  const deps: VerifyDeps = {
    selectOutreachByStatus: (status: OutreachStatus) => {
      if (status === "draft") return opts.draftRows ?? [];
      if (status === "sent") return opts.sentRows ?? [];
      return [];
    },
    getDraft: opts.getDraft ?? (async () => "exists"),
    searchMessages: opts.searchMessages ?? (async () => []),
    getMessageMetadata:
      opts.getMessageMetadata ??
      (async (): Promise<MessageMetadata> => ({ snippet: "", internalDate: 0 })),
    updateOutreachStatus: (input: UpdateOutreachStatusInput) => {
      statusUpdates.push(input);
    },
    insertUndrafted: (row: InsertUndraftedInput) => {
      undrafted.push(row);
    },
    setRecruiterStatus: (email: string, status: RecruiterStatus, atIso: string) => {
      recruiterStatuses.push({ email, status, atIso });
    },
    lookupRecruiter: (email: string) => {
      const found = opts.recruitersByEmail?.[email];
      if (!found) return null;
      return {
        email,
        company: found.company,
        contactName: found.contactName,
        phone: found.phone,
        source: found.source,
        status: found.status ?? "verified",
        registrySlug: found.registrySlug,
      };
    },
    readTab: opts.readTab ?? (async () => [["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"]]),
    appendRows: async (profileId: string, tab: string, rows: string[][]) => {
      appended.push({ profileId, tab, rows });
    },
    now: opts.now ?? (() => new Date("2026-07-06T12:00:00.000Z")),
  };

  return { deps, statusUpdates, undrafted, recruiterStatuses, appended };
}

test("epochSeconds converts an ISO timestamp to integer epoch seconds (no ms)", () => {
  assert.equal(epochSeconds("2026-07-01T00:00:00.000Z"), 1782864000);
  assert.equal(epochSeconds("2026-07-01T00:00:00.500Z"), 1782864000);
});

test("runVerify: draft still exists -> only last_checked_at is updated", async () => {
  const { deps, statusUpdates } = harness({ draftRows: [mkRow()] });
  const result = await runVerify({ profileId: "default", runId: null, deps });

  assert.equal(result.checkedDrafts, 1);
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0]?.status, "draft");
  assert.ok(statusUpdates[0].lastCheckedAt);
});

test("runVerify: draft gone + a sent message after drafted_at -> status sent, sent_at from newest hit", async () => {
  const { deps, statusUpdates } = harness({
    draftRows: [mkRow()],
    getDraft: async () => "gone",
    searchMessages: async () => [{ id: "m1", threadId: "t1" }],
    getMessageMetadata: async () => ({ snippet: "", internalDate: 1782900000000 }),
  });

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.sent, 1);
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0]?.status, "sent");
  assert.equal(statusUpdates[0].sentAt, new Date(1782900000000).toISOString());
  assert.equal(statusUpdates[0].gmailMessageId, "m1");
});

test("runVerify: draft gone + no sent message -> discarded + one undrafted row per bundled role", async () => {
  const roles = [
    { title: "Data Analyst", jobUrl: "https://acme.com/1", severity: "green", score: 0.9 },
    { title: "BI Engineer", jobUrl: "https://acme.com/2", severity: "yellow", score: 0.7 },
  ];
  const { deps, statusUpdates, undrafted } = harness({
    draftRows: [mkRow({ rolesJson: JSON.stringify(roles), runId: 42, runDate: "2026-06-30" })],
    getDraft: async () => "gone",
    searchMessages: async () => [],
  });

  const result = await runVerify({ profileId: "default", runId: 99, deps });
  assert.equal(result.discarded, 1);
  assert.equal(statusUpdates[0]?.status, "discarded");
  assert.equal(undrafted.length, 2);
  for (const row of undrafted) {
    assert.equal(row.reason, "draft_discarded");
    // runId/runDate trace back to the row's ORIGINAL drafting run (42), not the
    // verify pass's own run (99) — keeps the sheet row attributable to the run
    // whose posting match produced it.
    assert.equal(row.runDate, "2026-06-30");
    assert.equal(row.runId, 42);
  }
  assert.equal(undrafted[0]?.jobTitle, "Data Analyst");
  assert.equal(undrafted[1]?.jobTitle, "BI Engineer");
});

test("runVerify: sent row with a bounce hit -> status bounced + recruiter globally bounced", async () => {
  const { deps, statusUpdates, recruiterStatuses } = harness({
    sentRows: [mkRow({ status: "sent", sentAt: "2026-07-01T00:00:00.000Z" })],
    searchMessages: async (_profileId, q) => (q.includes("mailer-daemon") ? [{ id: "b1", threadId: "bt1" }] : []),
    getMessageMetadata: async () => ({ snippet: "550 5.1.1 user unknown", internalDate: 1782900000000 }),
  });

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.bounced, 1);
  assert.equal(statusUpdates[0]?.status, "bounced");
  assert.equal(statusUpdates[0].failureDetail, "550 5.1.1 user unknown");
  assert.equal(recruiterStatuses.length, 1);
  assert.equal(recruiterStatuses[0]?.email, "recruiter@acme.com");
  assert.equal(recruiterStatuses[0].status, "bounced");
});

test("runVerify: sent row past verifyAfterHours with no bounce -> status verified + recruiter globally verified", async () => {
  const { deps, statusUpdates, recruiterStatuses } = harness({
    sentRows: [mkRow({ status: "sent", sentAt: "2026-07-05T00:00:00.000Z" })], // >24h before 'now' (2026-07-06T12:00Z)
    searchMessages: async () => [],
  });

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.verified, 1);
  assert.equal(statusUpdates[0]?.status, "verified");
  assert.equal(recruiterStatuses.length, 1);
  assert.equal(recruiterStatuses[0]?.status, "verified");
});

test("runVerify: newly-verified raw-csv recruiter is appended to the Recruiters List tab", async () => {
  const { deps, appended } = harness({
    sentRows: [mkRow({ status: "sent", sentAt: "2026-07-05T00:00:00.000Z", recruiterEmail: "raw@acme.com" })],
    searchMessages: async () => [],
    recruitersByEmail: {
      "raw@acme.com": { source: "raw-csv", company: "Acme", contactName: "Jane", phone: "123", registrySlug: "acme" },
    },
  });

  await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.tab, "Recruiters List");
  assert.deepEqual(appended[0].rows, [["Acme", "Jane", "123", "raw@acme.com", "job-hunter-bot", "2026-07-06", "acme"]]);
});

test("runVerify: newly-verified manual-sheet recruiter is NOT appended (already on the tab)", async () => {
  const { deps, appended } = harness({
    sentRows: [mkRow({ status: "sent", sentAt: "2026-07-05T00:00:00.000Z", recruiterEmail: "manual@acme.com" })],
    searchMessages: async () => [],
    recruitersByEmail: {
      "manual@acme.com": { source: "manual-sheet", company: "Acme", contactName: "Jane", phone: null, registrySlug: null },
    },
  });

  await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(appended.length, 0);
});

test("runVerify: raw-csv recruiter already present on the Recruiters List tab is not re-appended", async () => {
  const { deps, appended } = harness({
    sentRows: [mkRow({ status: "sent", sentAt: "2026-07-05T00:00:00.000Z", recruiterEmail: "raw@acme.com" })],
    searchMessages: async () => [],
    recruitersByEmail: {
      "raw@acme.com": { source: "raw-csv", company: "Acme", contactName: "Jane", phone: null, registrySlug: null },
    },
    readTab: async () => [
      ["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"],
      ["Acme", "Jane", "", "raw@acme.com", "manual", "2026-01-01", ""],
    ],
  });

  await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(appended.length, 0);
});

test("runVerify: sent row not yet 24h old and no bounce -> only last_checked_at updates", async () => {
  const { deps, statusUpdates, recruiterStatuses } = harness({
    sentRows: [mkRow({ status: "sent", sentAt: "2026-07-06T11:00:00.000Z" })], // 1h before 'now'
    searchMessages: async () => [],
  });

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.verified, 0);
  assert.equal(result.bounced, 0);
  assert.equal(statusUpdates.length, 1);
  assert.equal(statusUpdates[0]?.status, "sent");
  assert.equal(recruiterStatuses.length, 0);
});

test("runVerify: GoogleAuthExpiredError from getDraft rethrows and stops the pass", async () => {
  const { deps } = harness({
    draftRows: [mkRow()],
    getDraft: async () => {
      throw new GoogleAuthExpiredError("default", "revoked");
    },
  });

  await assert.rejects(
    () => runVerify({ profileId: "default", runId: null, deps }),
    GoogleAuthExpiredError,
  );
});

test("runVerify: a non-auth error on one row is logged and does not stop the pass", async () => {
  let calls = 0;
  const { deps, statusUpdates } = harness({
    draftRows: [mkRow({ id: 1, recruiterEmail: "r1@acme.com" }), mkRow({ id: 2, recruiterEmail: "r2@acme.com" })],
    getDraft: async () => {
      calls++;
      if (calls === 1) throw new Error("Gmail 500");
      return "exists";
    },
  });

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.checkedDrafts, 1);
  assert.equal(statusUpdates.length, 1);
});

test("runVerify: only rows for the given profileId are checked (selectOutreachByStatus scoped upstream)", async () => {
  // selectOutreachByStatus is called with profileId in the real deps; here we
  // just confirm runVerify passes it through.
  let passedProfileId: string | null = null;
  const { deps } = harness({});
  deps.selectOutreachByStatus = (_status: OutreachStatus, profileId?: string) => {
    passedProfileId = profileId ?? null;
    return [];
  };

  await runVerify({ profileId: "vikrant", runId: null, deps });
  assert.equal(passedProfileId, "vikrant");
});

test("promotion skips a recruiter whose LIVE status is bounced (guard against cross-profile resurrection)", async () => {
  const { deps, appended } = harness({
    sentRows: [mkRow({ id: 71, status: "sent", sentAt: "2026-07-01T00:00:00.000Z", recruiterEmail: "dead@zombie.co" })],
    now: () => new Date("2026-07-05T00:00:00.000Z"),
    recruitersByEmail: {
      "dead@zombie.co": { source: "raw-csv", company: "Zombie Co", contactName: null, phone: null, registrySlug: null, status: "bounced" },
    },
  });
  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.verified, 1); // the OUTREACH row verifies (24h clean for this profile)
  assert.equal(appended.length, 0, "but the globally-bounced recruiter must NOT be promoted");
});

test("a recently-discarded row with a late-appearing sent hit is recovered to sent", async () => {
  const discardedRow = mkRow({ id: 88, status: "discarded", draftedAt: "2026-07-05T00:00:00.000Z" });
  const { deps, statusUpdates } = harness({
    searchMessages: async () => [{ id: "late-1", threadId: "t-late" }],
    getMessageMetadata: async () => ({ snippet: "", internalDate: 1783400000000 }),
    now: () => new Date("2026-07-07T00:00:00.000Z"),
  });
  const baseSelect = deps.selectOutreachByStatus;
  deps.selectOutreachByStatus = (status, profileId) =>
    status === "discarded" ? [discardedRow] : baseSelect(status, profileId);

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.sent, 1);
  const update = statusUpdates.find((u) => u.id === 88);
  assert.ok(update);
  assert.equal(update.status, "sent");
  assert.equal(update.gmailMessageId, "late-1");
});

test("an OLD discarded row is not re-checked (outside the recheck window)", async () => {
  const discardedRow = mkRow({ id: 89, status: "discarded", draftedAt: "2026-01-01T00:00:00.000Z" });
  const { deps, statusUpdates } = harness({
    searchMessages: async () => [{ id: "x", threadId: "t" }],
    now: () => new Date("2026-07-07T00:00:00.000Z"),
  });
  const baseSelect = deps.selectOutreachByStatus;
  deps.selectOutreachByStatus = (status, profileId) =>
    status === "discarded" ? [discardedRow] : baseSelect(status, profileId);

  const result = await runVerify({ profileId: "default", runId: null, deps });
  assert.equal(result.sent, 0);
  assert.equal(statusUpdates.find((u) => u.id === 89), undefined);
});
