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
// Tell sync.ts the file is now held open, so a Drive pull refuses to swap it out
// from under us instead of failing with EPERM (Windows) or silently reading the
// replaced file (Linux). See db/openState.ts.
markDbOpened();
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Wait instead of throwing SQLITE_BUSY when a script runs while the bot holds a write lock.
db.exec("PRAGMA busy_timeout = 5000");

const schema = readFileSync(schemaPath, "utf-8");
db.exec(schema);

// Migrations: CREATE TABLE IF NOT EXISTS won't add columns to an existing
// table, so newly introduced columns are ALTERed in idempotently here.
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

  // postings.profile_id requires folding it into the PK — SQLite can't ALTER a
  // PK, so rebuild the table once. Guarded by the column's absence (idempotent).
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

  // postings.jd_text: the gate reads the JD in-memory during the run and nothing
  // ever read the column back, so it was pure write-only bulk - 453 MB of a
  // 609 MB database. Dropped 2026-08-07. Runs after the profile_id rebuild above
  // so a pre-profile_id DB is migrated first, then loses the column here.
  // DROP COLUMN only hides it; VACUUM is what returns the disk space, hence the
  // one-time (and slow, ~30-60s on a 600 MB file) rewrite. Re-read table_info
  // because the rebuild above may have just recreated the table.
  const postingColsAfter = db.prepare("PRAGMA table_info(postings)").all().map((r) => PragmaRowSchema.parse(r));
  if (postingColsAfter.some((c) => c.name === "jd_text")) {
    db.exec("ALTER TABLE postings DROP COLUMN jd_text");
    logger.info("migration: dropped postings.jd_text; reclaiming space (VACUUM, may take ~1 min)");
    db.exec("VACUUM");
    logger.info("migration: VACUUM complete");
  }

  // brave_quota was the Brave Search API's monthly-quota tracker; the Brave
  // API was removed with the discovery pipeline (2026-07-15). Idempotent drop
  // cleans up existing local DBs that still carry the table.
  db.exec("DROP TABLE IF EXISTS brave_quota");
}

logger.info({ path: dbPath }, "sqlite initialized");

/**
 * Close the singleton connection. TERMINAL for the process: every module-scope
 * prepared statement in db/*.ts is bound to this handle, so anything touching the
 * DB afterwards throws.
 *
 * Exists for one caller - the post-run Drive push. Holding the handle open there
 * makes `PRAGMA wal_checkpoint(TRUNCATE)` return busy, which would silently
 * upload a .db missing whatever is still sitting in the -wal file.
 */
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
