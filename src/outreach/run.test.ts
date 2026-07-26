import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleAuthExpiredError } from "../google/auth.js";
import { at } from "../ats/test-helpers.js";
import type { RecruiterRow } from "../db/recruiters.js";
import type { OutreachNotifiedPosting } from "../db/postings.js";
import type { InsertOutreachInput, InsertUndraftedInput } from "../db/outreach.js";
import { groupByCompany, istDate, runOutreach, type RunOutreachDeps } from "./run.js";

function mkRecruiter(overrides: Partial<RecruiterRow> = {}): RecruiterRow {
  return {
    email: "recruiter@acme.com",
    company: "Acme",
    companyNorm: "acme",
    altNamesNorm: null,
    contactName: "Jane Doe",
    phone: null,
    source: "manual-sheet",
    registryProvider: null,
    registrySlug: null,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mkPosting(overrides: Partial<OutreachNotifiedPosting> = {}): OutreachNotifiedPosting {
  return {
    provider: "custom",
    company: "Acme",
    companySlug: "acme",
    jobTitle: "Data Analyst",
    jobUrl: "https://acme.com/jobs/1",
    location: "Bengaluru",
    llmConfidence: 0.9,
    severity: "green",
    ...overrides,
  };
}

interface Harness {
  deps: RunOutreachDeps;
  drafts: Array<{ profileId: string; mime: string }>;
  inserted: InsertOutreachInput[];
  undrafted: InsertUndraftedInput[];
}

function harness(opts: {
  postings?: OutreachNotifiedPosting[];
  recruiters?: RecruiterRow[];
  lastDraftedAt?: (email: string) => string | null;
  createDraft?: RunOutreachDeps["createDraft"];
  readResume?: RunOutreachDeps["readResume"];
} = {}): Harness {
  const drafts: Array<{ profileId: string; mime: string }> = [];
  const inserted: InsertOutreachInput[] = [];
  const undrafted: InsertUndraftedInput[] = [];

  const deps: RunOutreachDeps = {
    syncContacts: async () => ({ manual: 0, raw: 0 }),
    selectNotifiedPostingsSince: () => opts.postings ?? [],
    selectAllRecruiters: () => opts.recruiters ?? [],
    selectLastDraftedAt: (email: string) => (opts.lastDraftedAt ? opts.lastDraftedAt(email) : null),
    loadTemplate: () => ({
      subject: "Application for {{role_summary}} - {{sender_name}}",
      body: "Hi {{contact_name_or_there}},\n\n{{roles_block}}\n\n{{profile_pitch}}Thanks{{s_if_plural}}.\n{{sender_name}}\n{{sender_links}}\n",
    }),
    readResume:
      opts.readResume ??
      (() => Buffer.from("resume-bytes")),
    createDraft:
      opts.createDraft ??
      (async (profileId: string, mime: string) => {
        drafts.push({ profileId, mime });
        return { draftId: `draft-${drafts.length}`, messageId: `msg-${drafts.length}`, threadId: `thread-${drafts.length}` };
      }),
    insertOutreach: (row: InsertOutreachInput) => {
      inserted.push(row);
      return inserted.length;
    },
    insertUndrafted: (row: InsertUndraftedInput) => {
      undrafted.push(row);
    },
    now: () => new Date("2026-07-06T12:00:00.000Z"),
  };

  return { deps, drafts, inserted, undrafted };
}

test("istDate converts a UTC instant to the IST calendar date (YYYY-MM-DD)", () => {
  // 2026-07-06T19:00:00Z is 2026-07-07T00:30 IST (UTC+5:30) â€” crosses midnight.
  assert.equal(istDate(new Date("2026-07-06T19:00:00.000Z")), "2026-07-07");
  // 2026-07-06T18:00:00Z is 2026-07-06T23:30 IST â€” still the same day.
  assert.equal(istDate(new Date("2026-07-06T18:00:00.000Z")), "2026-07-06");
});

test("runOutreach creates one draft per eligible (company, recruiter) pair with bundled roles", async () => {
  const { deps, drafts, inserted } = harness({
    postings: [
      mkPosting({ jobTitle: "Data Analyst", jobUrl: "https://acme.com/1" }),
      mkPosting({ jobTitle: "BI Engineer", jobUrl: "https://acme.com/2" }),
    ],
    recruiters: [mkRecruiter({ email: "r1@acme.com" }), mkRecruiter({ email: "r2@acme.com" })],
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: 42, deps });

  assert.equal(result.draftsCreated, 2);
  assert.equal(result.companiesMatched, 1);
  assert.equal(drafts.length, 2);
  assert.equal(inserted.length, 2);
  for (const row of inserted) {
    const roles: unknown = JSON.parse(row.rolesJson);
    assert.ok(Array.isArray(roles));
    assert.equal(roles.length, 2);
  }
});

test("runOutreach filters postings to configured severities (default excludes anything but green/yellow)", async () => {
  const { deps, drafts } = harness({
    postings: [mkPosting({ severity: "green" }), mkPosting({ severity: "yellow", jobTitle: "Yellow Role" })],
    recruiters: [mkRecruiter()],
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(result.draftsCreated, 1);
  assert.equal(drafts.length, 1);
  // Multipart MIME (resume attached): the first base64 block after the text/plain
  // part's headers is the body; decode it and confirm the surviving posting's title.
  const parts = at(drafts, 0).mime.split(/--job-hunter-\S+\r\n/);
  const textPart = parts.find((p) => p.includes("text/plain"));
  const b64 = textPart?.split("\r\n\r\n")[1]?.trim().split("\r\n").join("") ?? "";
  const bodyText = Buffer.from(b64, "base64").toString("utf-8");
  assert.match(bodyText, /Data Analyst/);
});

test("runOutreach: zero contacts for a company inserts one undrafted row per posting with reason no_contact", async () => {
  const { deps, undrafted } = harness({
    postings: [mkPosting({ jobTitle: "Data Analyst" }), mkPosting({ jobTitle: "BI Engineer" })],
    recruiters: [],
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: 7, deps });
  assert.equal(result.draftsCreated, 0);
  assert.equal(result.undrafted, 2);
  assert.equal(undrafted.length, 2);
  for (const row of undrafted) {
    assert.equal(row.reason, "no_contact");
  }
});

test("runOutreach: all contacts on cooldown inserts undrafted rows with reason cooldown", async () => {
  const recentDraft = new Date("2026-07-01T00:00:00.000Z").toISOString();
  const { deps, undrafted } = harness({
    postings: [mkPosting()],
    recruiters: [mkRecruiter({ email: "cool@acme.com" })],
    lastDraftedAt: () => recentDraft,
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(result.draftsCreated, 0);
  assert.equal(undrafted.length, 1);
  assert.equal(undrafted[0]?.reason, "cooldown");
});

test("runOutreach: all contacts bounced inserts undrafted rows with reason bounced_contact", async () => {
  const { deps, undrafted } = harness({
    postings: [mkPosting()],
    recruiters: [mkRecruiter({ email: "dead@acme.com", status: "bounced" })],
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(result.draftsCreated, 0);
  assert.equal(undrafted.length, 1);
  assert.equal(undrafted[0]?.reason, "bounced_contact");
});

test("runOutreach: cooldown ineligibility takes priority over bounced when both are present", async () => {
  const recentDraft = new Date("2026-07-01T00:00:00.000Z").toISOString();
  const { deps, undrafted } = harness({
    postings: [mkPosting()],
    recruiters: [
      mkRecruiter({ email: "bounced@acme.com", status: "bounced" }),
      mkRecruiter({ email: "cooldown@acme.com" }),
    ],
    lastDraftedAt: (email) => (email === "cooldown@acme.com" ? recentDraft : null),
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(result.draftsCreated, 0);
  assert.equal(undrafted.length, 1);
  assert.equal(undrafted[0]?.reason, "cooldown");
});

test("runOutreach: a Gmail failure on one draft is logged and does not stop the run", async () => {
  let calls = 0;
  const { deps, inserted } = harness({
    postings: [mkPosting()],
    recruiters: [mkRecruiter({ email: "r1@acme.com" }), mkRecruiter({ email: "r2@acme.com" })],
    createDraft: async (_profileId, _mime) => {
      calls++;
      if (calls === 1) throw new Error("Gmail 500");
      return { draftId: "d2", messageId: "m2", threadId: "t2" };
    },
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(result.draftsCreated, 1);
  assert.equal(inserted.length, 1);
});

test("runOutreach: GoogleAuthExpiredError on a draft rethrows and stops the stage", async () => {
  const { deps } = harness({
    postings: [mkPosting()],
    recruiters: [mkRecruiter({ email: "r1@acme.com" }), mkRecruiter({ email: "r2@acme.com" })],
    createDraft: async () => {
      throw new GoogleAuthExpiredError("default", "revoked");
    },
  });

  await assert.rejects(
    () => runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps }),
    GoogleAuthExpiredError,
  );
});

test("runOutreach: attachResume=false attaches no resume and does not call readResume", async () => {
  let readResumeCalled = false;
  const { deps, drafts } = harness({
    postings: [mkPosting()],
    recruiters: [mkRecruiter()],
    readResume: () => {
      readResumeCalled = true;
      return Buffer.from("x");
    },
  });
  deps.attachResume = false;

  await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(readResumeCalled, false);
  assert.doesNotMatch(at(drafts, 0).mime, /application\/pdf/);
});

test("runOutreach: missing resume file warns and sends without attachment", async () => {
  const { deps, drafts } = harness({
    postings: [mkPosting()],
    recruiters: [mkRecruiter()],
    readResume: () => null,
  });

  const result = await runOutreach({ profileId: "default", sinceIso: "2026-01-01T00:00:00Z", runId: null, deps });
  assert.equal(result.draftsCreated, 1);
  assert.doesNotMatch(at(drafts, 0).mime, /application\/pdf/);
});

test("groupByCompany merges near-duplicate display names into one group (Wipro / Wipro Limited)", () => {
  const groups = groupByCompany([
    mkPosting({ company: "Wipro", jobTitle: "SDE II" }),
    mkPosting({ company: "Wipro Limited", jobTitle: "Frontend Engineer" }),
    mkPosting({ company: "Zoho Corporation", jobTitle: "Analyst" }),
  ]);
  assert.equal(groups.length, 2);
  const wipro = groups.find((g) => g.companyName === "Wipro");
  assert.ok(wipro, "first-seen spelling is the display name");
  assert.deepEqual(wipro.postings.map((p) => p.jobTitle), ["SDE II", "Frontend Engineer"]);
});
