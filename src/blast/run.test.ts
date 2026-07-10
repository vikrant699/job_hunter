// src/blast/run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBlast, blastLogTab, type BlastDeps } from "./run.js";
import { loadState, saveState, type BlastState } from "./state.js";

const NOW = new Date("2026-07-11T05:30:00.000Z"); // Sat before Mon 2026-07-13

/** Tab name every projection in these tests should land on (profileId "divya"). */
const BLAST_LOG_TAB = blastLogTab("divya");

const TEST_CONTENT = {
  resumeFilename: "Divya Rajput Resume.pdf",
  subjects: ["Subject One", "Subject Two", "Subject Three"],
  openers: [
    {
      hello: "I hope you're doing well.",
      withCompany: "I am reaching out to explore opportunities that your team at {company} may be hiring for.",
      fallback: "I am reaching out to explore opportunities that you may be hiring for.",
    },
    {
      hello: "I hope your week is going well.",
      withCompany: "I'm writing to check whether you or your team at {company} are currently hiring.",
      fallback: "I'm writing to check whether you are currently hiring.",
    },
    {
      hello: "I hope you're doing well.",
      withCompany: "I wanted to share my profile with {company} for any openings.",
      fallback: "I wanted to share my profile for any openings.",
    },
  ],
};

interface Harness {
  dir: string;
  paths: { template: string; content: string; resume: string; state: string };
  deps: BlastDeps;
  created: { mime: string }[];
  rewrites: { tab: string; header: string[]; rows: string[][] }[];
}

function makeHarness(rawRows: string[][], opts?: { failCreateAt?: number; bouncedEmails?: string[] }): Harness {
  const dir = mkdtempSync(join(tmpdir(), "blast-run-"));
  const paths = {
    template: join(dir, "template.md"),
    content: join(dir, "content.json"),
    resume: join(dir, "resume.pdf"),
    state: join(dir, "state.json"),
  };
  writeFileSync(paths.template, "{{greeting}}\n\n{{opener}}\n\nFixed body.\n", "utf-8");
  writeFileSync(paths.content, JSON.stringify(TEST_CONTENT), "utf-8");
  writeFileSync(paths.resume, "fake-pdf-bytes", "utf-8");

  const created: { mime: string }[] = [];
  const rewrites: { tab: string; header: string[]; rows: string[][] }[] = [];
  let createCalls = 0;

  const deps: BlastDeps = {
    readTab: () => Promise.resolve(rawRows),
    ensureTabs: () => Promise.resolve(),
    rewriteTab: (_p, tab, header, rows) => {
      rewrites.push({ tab, header, rows });
      return Promise.resolve();
    },
    createDraft: (_p, mime) => {
      createCalls++;
      if (opts?.failCreateAt !== undefined && createCalls === opts.failCreateAt) {
        return Promise.reject(new Error("Google API 429: quota"));
      }
      created.push({ mime });
      return Promise.resolve({ draftId: `d${String(createCalls)}`, messageId: `m${String(createCalls)}`, threadId: `t${String(createCalls)}` });
    },
    searchMessages: (_p, q) => {
      const hit = (opts?.bouncedEmails ?? []).some((e) => q.includes(`"${e}"`));
      return Promise.resolve(hit ? [{ id: "b1", threadId: "bt1" }] : []);
    },
    getMessageMetadata: () => Promise.resolve({ snippet: "Address not found", internalDate: NOW.getTime() }),
    readFile: () => Buffer.from("fake-pdf-bytes"),
    mxResolver: (domain) =>
      domain === "invalid.com"
        ? Promise.reject(new Error("ENOTFOUND"))
        : Promise.resolve([{ exchange: `mx.${domain}`, priority: 10 }]),
    now: () => NOW,
    sleepMs: () => Promise.resolve(),
  };
  return { dir, paths, deps, created, rewrites };
}

const HEADER = ["Company", "Email", "Contact Name", "Alt Names"];

test("drafts up to limit, records state, projects Blast Log, reports remaining", async () => {
  const h = makeHarness([
    HEADER,
    ["A Co", "a@a.com", "", ""],
    ["B Co", "b@b.com", "", ""],
    ["C Co", "c@c.com", "", ""],
  ]);
  try {
    const summary = await runBlast({ profileId: "divya", limit: 2, deps: h.deps, paths: h.paths });
    assert.equal(summary.drafted, 2);
    assert.equal(summary.batch, 1);
    assert.equal(summary.remaining, 1);
    assert.equal(h.created.length, 2);
    assert.match(h.created[0]?.mime ?? "", /To: a@a\.com/);
    // Attachment filename comes from the profile's content config.
    assert.match(h.created[0]?.mime ?? "", /filename="Divya Rajput Resume\.pdf"/);
    const state = loadState(h.paths.state);
    assert.deepEqual(state.records.map((r) => [r.email, r.status, r.batch]), [
      ["a@a.com", "drafted", 1],
      ["b@b.com", "drafted", 1],
    ]);
    const log = h.rewrites.at(-1);
    assert.equal(log?.tab, BLAST_LOG_TAB);
    assert.equal(log?.rows.length, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("MX-invalid addresses are recorded skipped_invalid and do not consume the limit", async () => {
  const h = makeHarness([
    HEADER,
    ["Bad", "x@invalid.com", "", ""],
    ["Good", "g@good.com", "", ""],
  ]);
  try {
    const summary = await runBlast({ profileId: "divya", limit: 1, deps: h.deps, paths: h.paths });
    assert.equal(summary.drafted, 1);
    assert.equal(summary.skippedInvalid, 1);
    const state = loadState(h.paths.state);
    assert.deepEqual(state.records.map((r) => [r.email, r.status]), [
      ["x@invalid.com", "skipped_invalid"],
      ["g@good.com", "drafted"],
    ]);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("crash mid-batch never re-drafts: state flushed per draft, re-run picks up after", async () => {
  const rows = [HEADER, ["A", "a@a.com", "", ""], ["B", "b@b.com", "", ""], ["C", "c@c.com", "", ""]];
  const h = makeHarness(rows, { failCreateAt: 3 });
  try {
    await assert.rejects(
      runBlast({ profileId: "divya", limit: 3, deps: h.deps, paths: h.paths }),
      /quota/,
    );
    assert.equal(loadState(h.paths.state).records.length, 2);
    // Sheet is only written on clean exit; a crashed run must not project.
    assert.equal(h.rewrites.length, 0);

    const h2 = makeHarness(rows);
    // Reuse the crashed run's state file with the fresh (non-failing) deps.
    const summary = await runBlast({
      profileId: "divya", limit: 3, force: true, deps: h2.deps, paths: { ...h2.paths, state: h.paths.state },
    });
    assert.equal(summary.drafted, 1);
    assert.match(h2.created[0]?.mime ?? "", /To: c@c\.com/);
    rmSync(h2.dir, { recursive: true, force: true });
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("same-week guard: refuses a second batch under 5 days old without --force", async () => {
  const h = makeHarness([HEADER, ["A", "a@a.com", "", ""], ["B", "b@b.com", "", ""]]);
  try {
    await runBlast({ profileId: "divya", limit: 1, deps: h.deps, paths: h.paths });
    await assert.rejects(
      runBlast({ profileId: "divya", limit: 1, deps: h.deps, paths: h.paths }),
      /same-week re-run/,
    );
    const summary = await runBlast({ profileId: "divya", limit: 1, force: true, deps: h.deps, paths: h.paths });
    assert.equal(summary.drafted, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("bounce stop-loss: refuses when last batch bounced > 10% without --force", async () => {
  const h = makeHarness([HEADER, ["A", "a@a.com", "", ""], ["B", "b@b.com", "", ""]], {
    bouncedEmails: ["old1@x.com"],
  });
  try {
    // Seed a week-old batch of 2, one of which will bounce in the sweep (50%).
    const seeded: BlastState = {
      lastSweepAt: null,
      records: [
        { email: "old1@x.com", company: "O", contactName: null, status: "drafted", batch: 1, variant: "S1/O1", draftId: "od1", at: "2026-07-04T05:30:00.000Z", note: null },
        { email: "old2@x.com", company: "O", contactName: null, status: "drafted", batch: 1, variant: "S2/O1", draftId: "od2", at: "2026-07-04T05:30:00.000Z", note: null },
      ],
    };
    saveState(h.paths.state, seeded);
    await assert.rejects(
      runBlast({ profileId: "divya", limit: 1, deps: h.deps, paths: h.paths }),
      /bounce rate/,
    );
    const summary = await runBlast({ profileId: "divya", limit: 1, force: true, deps: h.deps, paths: h.paths });
    assert.equal(summary.drafted, 1);
    assert.equal(summary.lastBatchBounceRatePct, 50);
    // The Blast Log projection must carry the sweep's bounce over to the sheet,
    // with the profile in column A.
    const bouncedRow = h.rewrites.at(-1)?.rows.find((r) => r[1] === "old1@x.com");
    assert.equal(bouncedRow?.[0], "divya");
    assert.equal(bouncedRow?.[4], "bounced");
    assert.equal(bouncedRow?.[8], "Address not found");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("verify-only: sweeps and projects the log but never reads template/content or drafts", async () => {
  const h = makeHarness([HEADER, ["A", "a@a.com", "", ""]]);
  try {
    rmSync(h.paths.template); // must not be needed in verify-only mode
    rmSync(h.paths.content);
    const summary = await runBlast({ profileId: "divya", verifyOnly: true, deps: h.deps, paths: h.paths });
    assert.equal(summary.drafted, 0);
    assert.equal(h.created.length, 0);
    assert.equal(h.rewrites.at(-1)?.tab, BLAST_LOG_TAB);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("variant rotation continues across batches (index base = drafted-ever count)", async () => {
  // Company names must pass companyForMention's >=3-char gate, otherwise every
  // variant would carry a "-fallback" suffix and hide the rotation being tested.
  const h = makeHarness([
    HEADER,
    ["Alpha Co", "a@a.com", "", ""], ["Beta Co", "b@b.com", "", ""], ["Gamma Co", "c@c.com", "", ""], ["Delta Co", "d@d.com", "", ""],
  ]);
  try {
    await runBlast({ profileId: "divya", limit: 3, deps: h.deps, paths: h.paths });
    await runBlast({ profileId: "divya", limit: 1, force: true, deps: h.deps, paths: h.paths });
    const state = loadState(h.paths.state);
    assert.deepEqual(
      state.records.map((r) => r.variant),
      ["S1/O1", "S2/O1", "S3/O1", "S1/O2"],
    );
    assert.equal(state.records[3]?.batch, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
