import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "schema.sql");
const dbPath = resolve(process.cwd(), config.storage.dbPath);

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
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
}

logger.info({ path: dbPath }, "sqlite initialized");

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
  return row === undefined || row === null ? undefined : schema.parse(row);
}
