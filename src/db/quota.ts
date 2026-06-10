import { z } from "zod";
import { db, queryOne } from "./db.js";

const BraveQuotaRowSchema = z.object({
  count: z.number(),
});

const selectBraveQuotaStmt = db.prepare(
  "SELECT count FROM brave_quota WHERE month = :month",
);
// Increment happens in SQL (`count + :by`), not read-then-write in JS, so two
// processes sharing the DB (bot + a script) can't under-count the quota.
const incrementBraveQuotaStmt = db.prepare(`
  INSERT INTO brave_quota (month, count, updated_at) VALUES (:month, :by, :now)
  ON CONFLICT(month) DO UPDATE SET count = count + :by, updated_at = :now
`);

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function getBraveQuotaUsed(): number {
  const row = queryOne(selectBraveQuotaStmt, BraveQuotaRowSchema, {
    month: currentMonthKey(),
  });
  return row?.count ?? 0;
}

export function incrementBraveQuota(by: number = 1): number {
  const month = currentMonthKey();
  incrementBraveQuotaStmt.run({ month, by, now: new Date().toISOString() });
  return getBraveQuotaUsed();
}
