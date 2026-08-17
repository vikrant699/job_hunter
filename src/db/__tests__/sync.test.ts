import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  compareState,
  decideBeforeRun,
  assertPushSafe,
  readLocalState,
  checkpointWal,
  pullDb,
  pushDb,
  syncSkipReason,
} from "../sync.js";
import type { LocalDbState } from "../sync.js";
import { isDbOpen } from "../openState.js";

const NOW = 1_770_000_000_000;

test("compareState reports in-sync when both sides match", () => {
  assert.equal(compareState(NOW, NOW), "in-sync");
});

// A few seconds of drift must not read as "someone else pushed" and trigger a pointless pull.
test("compareState tolerates small clock skew in either direction", () => {
  assert.equal(compareState(NOW + 4_000, NOW), "in-sync");
  assert.equal(compareState(NOW - 4_000, NOW), "in-sync");
});

test("compareState detects a genuinely newer remote", () => {
  assert.equal(compareState(NOW, NOW + 60_000), "remote-newer");
});

test("compareState detects a genuinely newer local", () => {
  assert.equal(compareState(NOW + 60_000, NOW), "local-newer");
});

test("compareState reports no-remote on a first-ever push", () => {
  assert.equal(compareState(NOW, null), "no-remote");
});

test("compareState reports no-local on a fresh machine", () => {
  assert.equal(compareState(null, NOW), "no-local");
});

test("compareState reports no-local when neither side exists", () => {
  assert.equal(compareState(null, null), "no-local");
});

// Just past tolerance must flip the verdict; this decides whether a run pulls before touching the DB.
test("compareState flips exactly outside the skew tolerance", () => {
  assert.equal(compareState(NOW, NOW + 5_000), "in-sync");
  assert.equal(compareState(NOW, NOW + 5_001), "remote-newer");
  assert.equal(compareState(NOW + 5_001, NOW), "local-newer");
});

/* ===== decideBeforeRun: the fresh-machine case mtime cannot see ===== */

function local(overrides: Partial<LocalDbState> = {}): LocalDbState {
  return { mtimeMs: NOW, bytes: 50_000_000, postings: 118_867, ...overrides };
}

test("decideBeforeRun defers to the timestamps for a populated database", () => {
  assert.equal(decideBeforeRun(local(), NOW), "in-sync");
  assert.equal(decideBeforeRun(local(), NOW + 60_000), "remote-newer");
  assert.equal(decideBeforeRun(local({ mtimeMs: NOW + 60_000 }), NOW), "local-newer");
});

// db.ts creates the file on import, so a fresh machine's empty DB has mtime=now and looks newer than the real backup.
test("decideBeforeRun treats a zero-posting local DB as no-local, however new it is", () => {
  assert.equal(decideBeforeRun(local({ postings: 0, mtimeMs: NOW + 999_999 }), NOW), "no-local");
});

test("decideBeforeRun treats an unreadable/tableless local DB as no-local", () => {
  assert.equal(decideBeforeRun(local({ postings: null }), NOW), "no-local");
});

test("decideBeforeRun reports no-remote when Drive holds nothing, even for a fresh local", () => {
  assert.equal(decideBeforeRun(local({ postings: 0 }), null), "no-remote");
});

/* ===== assertPushSafe ===== */

test("assertPushSafe allows a normal push", () => {
  assertPushSafe(local(), 50_000_000, false);
});

test("assertPushSafe allows the first-ever push when there is no remote", () => {
  assertPushSafe(local(), null, false);
});

test("assertPushSafe refuses to push an empty database over a real backup", () => {
  assert.throws(() => assertPushSafe(local({ postings: 0 }), 50_000_000, false), /no postings/);
});

test("assertPushSafe refuses an empty database even with no remote size reported", () => {
  assert.throws(() => assertPushSafe(local({ postings: 0 }), null, false), /no postings/);
});

test("assertPushSafe refuses a local DB less than half the remote's size", () => {
  assert.throws(
    () => assertPushSafe(local({ bytes: 20_000_000 }), 50_000_000, false),
    /less than half/,
  );
});

test("assertPushSafe allows a shrink that stays within the ratio", () => {
  assertPushSafe(local({ bytes: 26_000_000 }), 50_000_000, false);
});

// A deliberate shrink is a real case, so the refusal has to be overridable.
test("assertPushSafe honours force for a deliberate shrink", () => {
  assertPushSafe(local({ bytes: 51_000_000 }), 609_000_000, true);
  assertPushSafe(local({ postings: 0 }), 50_000_000, true);
});

/* ===== readLocalState ===== */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "job-hunter-sync-"));
}

function makeDb(path: string, postingRows: number): void {
  const handle = new DatabaseSync(path);
  handle.exec("CREATE TABLE postings (id INTEGER PRIMARY KEY, job_title TEXT)");
  for (let i = 0; i < postingRows; i++) {
    handle.prepare("INSERT INTO postings (job_title) VALUES (?)").run(`job ${i}`);
  }
  handle.close();
}

test("readLocalState reports nulls when there is no database at all", () => {
  const state = readLocalState(join(tempDir(), "missing.db"));
  assert.deepEqual(state, { mtimeMs: null, bytes: 0, postings: null });
});

test("readLocalState counts postings and reports size", () => {
  const path = join(tempDir(), "some.db");
  makeDb(path, 7);
  const state = readLocalState(path);
  assert.equal(state.postings, 7);
  assert.ok(state.bytes > 0);
  assert.ok(state.mtimeMs !== null);
});

test("readLocalState reports 0 postings for a freshly created database", () => {
  const path = join(tempDir(), "fresh.db");
  makeDb(path, 0);
  assert.equal(readLocalState(path).postings, 0);
});

test("readLocalState survives a file that is not a database", () => {
  const path = join(tempDir(), "garbage.db");
  writeFileSync(path, "this is not sqlite");
  const state = readLocalState(path);
  assert.equal(state.postings, null);
  assert.ok(state.bytes > 0, "size still reported so the caller can log it");
});

/* ===== checkpointWal: busy is transient, not a defect ===== */

/** A WAL-mode database with an open writer connection - both load-bearing, or a closed fixture would leave nothing that can report busy and these tests would pass vacuously. */
function makeWalDb(path: string, rows: number): DatabaseSync {
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("CREATE TABLE postings (id INTEGER PRIMARY KEY, job_title TEXT)");
  for (let i = 0; i < rows; i++) {
    writer.prepare("INSERT INTO postings (job_title) VALUES (?)").run(`job ${i}`);
  }
  return writer;
}

/** A second connection sitting in an open read transaction — what a TRUNCATE waits for. */
function openReader(path: string): DatabaseSync {
  const reader = new DatabaseSync(path);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) AS n FROM postings").get();
  return reader;
}

const FAST = { timeoutMs: 200, retryDelayMs: 20, busyTimeoutMs: 20 };

test("checkpointWal succeeds on an unheld database", async () => {
  const path = join(tempDir(), "wal.db");
  const writer = makeWalDb(path, 3);
  try {
    await checkpointWal(path, FAST);
  } finally {
    writer.close();
  }
});

// The behaviour that matters: wait for the other connection rather than treating a
// perfectly ordinary lock as a failed push.
test("checkpointWal retries while another connection holds the DB, then succeeds", async () => {
  const path = join(tempDir(), "wal.db");
  const writer = makeWalDb(path, 3);
  const reader = openReader(path);
  // Release mid-flight, after the first attempt has certainly reported busy.
  const release = setTimeout(() => {
    reader.exec("COMMIT");
    reader.close();
  }, 60);

  try {
    const started = Date.now();
    await checkpointWal(path, { timeoutMs: 5_000, retryDelayMs: 20, busyTimeoutMs: 20 });
    assert.ok(Date.now() - started >= 50, "should have waited for the reader rather than failing");
  } finally {
    clearTimeout(release);
    writer.close();
  }
});

// A reader on the current snapshot blocks only the truncation; every frame still reached the .db, so the push must proceed.
test("checkpointWal proceeds after the timeout when every frame reached the database", async () => {
  const path = join(tempDir(), "wal.db");
  const writer = makeWalDb(path, 3);
  const reader = openReader(path);
  try {
    const started = Date.now();
    await checkpointWal(path, FAST);
    assert.ok(
      Date.now() - started >= FAST.timeoutMs,
      "should have spent the whole window retrying before settling for an untruncated WAL",
    );
  } finally {
    reader.close();
    writer.close();
  }
});

// The one case that must fail: a reader pinning an old snapshot stops frames being copied, so the .db is missing committed rows.
test("checkpointWal throws when frames are still only in the WAL", async () => {
  const path = join(tempDir(), "wal.db");
  const writer = makeWalDb(path, 1);
  const reader = openReader(path); // pins the snapshot as it is now
  for (let i = 0; i < 200; i++) {
    writer.prepare("INSERT INTO postings (job_title) VALUES (?)").run(`later ${i}`);
  }
  try {
    await assert.rejects(checkpointWal(path, FAST), /still in the WAL/);
  } finally {
    reader.close();
    writer.close();
  }
});

/* ===== pullDb / pushDb over a stubbed Drive ===== */

const REMOTE_MODIFIED = "2026-08-07T10:30:00.000Z";

/** Emulates just enough of the Drive REST surface for sync.ts (name lookup, resumable-upload handshake, media download); records what was uploaded. */
function driveStub(options: {
  remote: { id: string; size: number } | null;
  payload?: Buffer;
}): { fetchFn: typeof fetch; uploaded: () => Buffer | null } {
  let uploaded: Buffer | null = null;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/upload/drive/v3/files") && !url.includes("session")) {
      return new Response("{}", {
        status: 200,
        headers: { location: "https://upload.example/session-1" },
      });
    }
    if (url.startsWith("https://upload.example/session-1")) {
      const body = init?.body;
      uploaded = Buffer.from(body instanceof Uint8Array ? body : []);
      // Drive's default field set omits modifiedTime/size, exactly like the real API, forcing the code to read metadata back itself.
      return new Response(JSON.stringify({ id: "file-1", name: "job_hunter.db", mimeType: "application/octet-stream", kind: "drive#file" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Single-file metadata read-back (has a fields= query, no q=).
    if (url.includes("/drive/v3/files/") && url.includes("fields=")) {
      return new Response(
        JSON.stringify({
          id: "file-1",
          name: "job_hunter.db",
          size: String(uploaded?.byteLength ?? 0),
          modifiedTime: REMOTE_MODIFIED,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("alt=media")) {
      return new Response(options.payload ?? Buffer.alloc(0), { status: 200 });
    }
    // Name lookup.
    const files =
      options.remote === null
        ? []
        : [
            {
              id: options.remote.id,
              name: "job_hunter.db",
              size: String(options.remote.size),
              modifiedTime: REMOTE_MODIFIED,
            },
          ];
    return new Response(JSON.stringify({ files }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, uploaded: () => uploaded };
}

/** A token file the real auth module will accept without touching the network. */
function authStub(): { fetchFn: typeof fetch; tokenPath: string; readFile: () => string; existsSync: () => boolean; writeFileAtomic: () => void; now: () => number } {
  return {
    fetchFn: async () => new Response("{}", { status: 200 }),
    tokenPath: "unused",
    readFile: () =>
      JSON.stringify({ refresh_token: "r", access_token: "a", expiry: NOW + 3_600_000 }),
    existsSync: () => true,
    writeFileAtomic: () => undefined,
    now: () => NOW,
  };
}

test("pullDb swaps in the downloaded database and matches the remote timestamp", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 1);

  const incoming = join(dir, "incoming.db");
  makeDb(incoming, 42);
  const payload = readFileSync(incoming);

  const drive = driveStub({ remote: { id: "file-1", size: payload.byteLength }, payload });
  const result = await pullDb("vikrant", {
    dbPath,
    fetchFn: drive.fetchFn,
    authDeps: authStub(),
  });

  assert.equal(result.action, "downloaded");
  assert.equal(readLocalState(dbPath).postings, 42, "the local file is now the remote one");
  assert.ok(!existsSync(`${dbPath}.pull-tmp`), "no temp file left behind");
  // The next run must read in-sync, not "remote-newer", so it doesn't re-download what it already has.
  assert.equal(statSync(dbPath).mtimeMs, Date.parse(REMOTE_MODIFIED));
  assert.equal(compareState(statSync(dbPath).mtimeMs, Date.parse(REMOTE_MODIFIED)), "in-sync");
});

test("pullDb leaves the local database untouched when the download is corrupt", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 5);

  const drive = driveStub({
    remote: { id: "file-1", size: 12 },
    payload: Buffer.from("not a database"),
  });
  await assert.rejects(
    pullDb("vikrant", { dbPath, fetchFn: drive.fetchFn, authDeps: authStub() }),
    /file is not a database|integrity_check/i,
  );
  assert.equal(readLocalState(dbPath).postings, 5, "original data survived");
  assert.ok(!existsSync(`${dbPath}.pull-tmp`), "the rejected temp file was cleaned up");
});

test("pullDb reports no-remote instead of failing when Drive holds nothing", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 2);
  const drive = driveStub({ remote: null });

  const result = await pullDb("vikrant", { dbPath, fetchFn: drive.fetchFn, authDeps: authStub() });
  assert.equal(result.action, "skipped");
  assert.equal(result.verdict, "no-remote");
});

// This test file runs in a process where db/db.ts is loaded, so the guard must be live here.
test("pullDb refuses to swap the file while db.ts holds it open", async () => {
  await import("../db.js");
  assert.equal(isDbOpen(), true, "importing db.ts must mark the handle open");

  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 3);
  const drive = driveStub({ remote: { id: "file-1", size: 10 } });

  await assert.rejects(
    pullDb("vikrant", { dbPath, fetchFn: drive.fetchFn, authDeps: authStub() }),
    /refusing to pull.*already open/s,
  );
  assert.equal(readLocalState(dbPath).postings, 3, "nothing was touched");
});

test("pushDb uploads the local bytes and matches the remote timestamp", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 9);

  const drive = driveStub({ remote: { id: "file-1", size: statSync(dbPath).size } });
  const result = await pushDb("vikrant", {
    dbPath,
    fetchFn: drive.fetchFn,
    authDeps: authStub(),
  });

  assert.equal(result.action, "uploaded");
  const uploaded = drive.uploaded();
  assert.ok(uploaded !== null && uploaded.byteLength > 0, "bytes actually left the machine");
  assert.equal(statSync(dbPath).mtimeMs, Date.parse(REMOTE_MODIFIED));
});

test("pushDb refuses to overwrite the backup with a freshly created database", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 0);
  const drive = driveStub({ remote: { id: "file-1", size: 50_000_000 } });

  await assert.rejects(
    pushDb("vikrant", { dbPath, fetchFn: drive.fetchFn, authDeps: authStub() }),
    /no postings/,
  );
  assert.equal(drive.uploaded(), null, "nothing was uploaded");
});

test("pushDb honours force for a deliberately shrunken database", async () => {
  const dir = tempDir();
  const dbPath = join(dir, "job_hunter.db");
  makeDb(dbPath, 4);
  const drive = driveStub({ remote: { id: "file-1", size: 900_000_000 } });

  await assert.rejects(
    pushDb("vikrant", { dbPath, fetchFn: drive.fetchFn, authDeps: authStub() }),
    /less than half/,
  );
  const forced = await pushDb("vikrant", {
    dbPath,
    fetchFn: drive.fetchFn,
    authDeps: authStub(),
    force: true,
  });
  assert.equal(forced.action, "uploaded");
});

/* ===== the profile pin ===== */

test("syncSkipReason allows every profile while DB_SYNC_PROFILE is unset", () => {
  // config reads the env at import; the suite runs without DB_SYNC_PROFILE set.
  assert.equal(syncSkipReason("vikrant"), null);
  assert.equal(syncSkipReason("divya"), null);
});
