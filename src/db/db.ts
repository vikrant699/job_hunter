import { DatabaseSync } from "node:sqlite";
import type { StatementSync, SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { markDbOpened, markDbClosed } from "./openState.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "schema.sql");
const dbPath = resolve(process.cwd(), config.storage.dbPath);

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
// Tell sync.ts the file is held open, so a Drive pull refuses to swap it instead of EPERM (Windows) / silently reading the replaced file (Linux).
markDbOpened();
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Wait instead of throwing SQLITE_BUSY when a script runs while the bot holds a write lock.
db.exec("PRAGMA busy_timeout = 5000");

const schema = readFileSync(schemaPath, "utf-8");
db.exec(schema);

// CREATE TABLE IF NOT EXISTS won't add columns to an existing table, so new columns are ALTERed in idempotently here.
{
  const PragmaRowSchema = z.object({ name: z.string() });
  const cols = db
    .prepare("PRAGMA table_info(companies)")
    .all()
    .map((row) => PragmaRowSchema.parse(row));
  const has = (name: string): boolean => cols.some((c) => c.name === name);
  if (!has("api_meta")) db.exec("ALTER TABLE companies ADD COLUMN api_meta TEXT");
  if (!has("zero_yield_streak")) db.exec("ALTER TABLE companies ADD COLUMN zero_yield_streak INTEGER NOT NULL DEFAULT 0");
  if (!has("url_suspect")) db.exec("ALTER TABLE companies ADD COLUMN url_suspect INTEGER NOT NULL DEFAULT 0");

  // runs.profile_id — simple add.
  const runCols = db.prepare("PRAGMA table_info(runs)").all().map((r) => PragmaRowSchema.parse(r));
  if (!runCols.some((c) => c.name === "profile_id")) {
    db.exec("ALTER TABLE runs ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'");
  }

  // postings.profile_id requires folding it into the PK; SQLite can't ALTER a PK, so rebuild the table once (guarded by column absence).
  const postingCols = db.prepare("PRAGMA table_info(postings)").all().map((r) => PragmaRowSchema.parse(r));
  if (!postingCols.some((c) => c.name === "profile_id")) {
    db.exec(`
      CREATE TABLE postings_new (
        provider       TEXT    NOT NULL,
        external_id    TEXT    NOT NULL,
        company_slug   TEXT    NOT NULL,
        job_title      TEXT,
        job_url        TEXT    NOT NULL,
        location       TEXT,
        is_remote      INTEGER NOT NULL DEFAULT 0,
        posted_at      TEXT,
        discovered_at  TEXT    NOT NULL,
        profile_id     TEXT    NOT NULL DEFAULT 'default',
        llm_relevant   INTEGER,
        llm_reason     TEXT,
        llm_confidence REAL,
        yoe_min        REAL,
        yoe_max        REAL,
        drop_stage     TEXT,
        notified_at    TEXT,
        PRIMARY KEY (provider, external_id, profile_id)
      );
      INSERT INTO postings_new
        (provider, external_id, company_slug, job_title, job_url, location,
         is_remote, posted_at, discovered_at, profile_id,
         llm_relevant, llm_reason, llm_confidence, yoe_min, yoe_max, drop_stage, notified_at)
        SELECT
         provider, external_id, company_slug, job_title, job_url, location,
         is_remote, posted_at, discovered_at, 'default',
         llm_relevant, llm_reason, llm_confidence, yoe_min, yoe_max, drop_stage, notified_at
        FROM postings;
      DROP TABLE postings;
      ALTER TABLE postings_new RENAME TO postings;
      CREATE INDEX IF NOT EXISTS idx_postings_company ON postings(provider, company_slug);
      CREATE INDEX IF NOT EXISTS idx_postings_discovered ON postings(discovered_at);
    `);
    logger.info("migration: postings rebuilt with profile_id in PK (existing rows -> 'default')");
  }

  // postings.jd_text was write-only (the gate reads JDs in-memory, nothing reads the column back); runs after the profile_id
  // rebuild so a pre-profile_id DB migrates first. DROP COLUMN only hides it, so VACUUM reclaims the disk space.
  const postingColsAfter = db.prepare("PRAGMA table_info(postings)").all().map((r) => PragmaRowSchema.parse(r));
  if (postingColsAfter.some((c) => c.name === "jd_text")) {
    db.exec("ALTER TABLE postings DROP COLUMN jd_text");
    logger.info("migration: dropped postings.jd_text; reclaiming space (VACUUM, may take ~1 min)");
    db.exec("VACUUM");
    logger.info("migration: VACUUM complete");
  }

  // postings.last_seen_at / removed_at — the posting-lifecycle columns; runs after the profile_id rebuild so a
  // pre-profile_id DB gets them added to the rebuilt table, not the dropped one.
  const postingColsLifecycle = db.prepare("PRAGMA table_info(postings)").all().map((r) => PragmaRowSchema.parse(r));
  if (!postingColsLifecycle.some((c) => c.name === "last_seen_at")) {
    db.exec("ALTER TABLE postings ADD COLUMN last_seen_at TEXT");
  }
  if (!postingColsLifecycle.some((c) => c.name === "removed_at")) {
    db.exec("ALTER TABLE postings ADD COLUMN removed_at TEXT");
  }
  // Idempotent backfill: a no-op once every row has last_seen_at, so safe to run on every startup.
  db.exec("UPDATE postings SET last_seen_at = discovered_at WHERE last_seen_at IS NULL");

  // brave_quota is a leftover from the removed discovery pipeline; idempotent drop cleans up old local DBs.
  db.exec("DROP TABLE IF EXISTS brave_quota");
}

logger.info({ path: dbPath }, "sqlite initialized");

/** Close the singleton connection; terminal for the process (every module-scope prepared statement is bound to this handle).
 *  Exists for the post-run Drive push, since a still-open handle makes wal_checkpoint(TRUNCATE) return busy. */
export function closeDb(): void {
  db.close();
  markDbClosed();
  logger.info("sqlite closed for sync");
}

export function queryAll<T>(
  stmt: StatementSync,
  schema: z.ZodType<T>,
  params: Record<string, SQLInputValue> = {},
): T[] {
  return stmt.all(params).map((row) => schema.parse(row));
}

export function queryOne<T>(
  stmt: StatementSync,
  schema: z.ZodType<T>,
  params: Record<string, SQLInputValue> = {},
): T | undefined {
  const row = stmt.get(params);
  return row === undefined ? undefined : schema.parse(row);
}
