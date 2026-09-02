/**
 * Registry health report (read-only).
 *   node --import tsx scripts/registryHealth.ts
 * Yield telemetry here is a prioritization signal (who to investigate), not a removal criterion.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { db } from "../src/db/db.js";
import { config } from "../src/config.js";

const countRow = z.object({ n: z.number() });
const num = (s: string): number => countRow.parse(db.prepare(s).get()).n;
const query = <T>(s: string, schema: z.ZodType<T>): T[] => db.prepare(s).all().map((r) => schema.parse(r));

console.log("REGISTRY HEALTH —", new Date().toISOString());
console.log("=".repeat(60));

console.log("\nTOTAL companies:", num("SELECT COUNT(*) n FROM companies"));

console.log("\n[STATUS]");
const statusRow = z.object({ s: z.string(), n: z.number() });
for (const r of query("SELECT COALESCE(status,'active') s, COUNT(*) n FROM companies GROUP BY s ORDER BY n DESC", statusRow))
  console.log(`  ${r.s.padEnd(12)} ${r.n}`);

console.log("\n[STRATEGY]  total / reachable / ever-matched");
const stratRow = z.object({ ps: z.string(), tot: z.number(), ok: z.number(), prod: z.number() });
for (const r of query(
  `SELECT parsing_strategy ps, COUNT(*) tot,
     SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) ok,
     SUM(CASE WHEN COALESCE(postings_matched_total,0)>0 THEN 1 ELSE 0 END) prod
   FROM companies GROUP BY ps ORDER BY tot DESC`,
  stratRow,
)) console.log(`  ${r.ps.padEnd(22)} ${String(r.tot).padStart(4)} / ${String(r.ok).padStart(4)} / ${r.prod}`);

console.log("\n[ats-api PROVIDERS]  total / reachable / had-jobs");
const provRow = z.object({ provider: z.string(), tot: z.number(), ok: z.number(), hj: z.number() });
for (const r of query(
  `SELECT provider, COUNT(*) tot,
     SUM(CASE WHEN last_success_at IS NOT NULL THEN 1 ELSE 0 END) ok,
     SUM(CASE WHEN COALESCE(postings_seen_total,0)>0 THEN 1 ELSE 0 END) hj
   FROM companies WHERE parsing_strategy='ats-api' GROUP BY provider ORDER BY tot DESC`,
  provRow,
)) console.log(`  ${r.provider.padEnd(16)} ${String(r.tot).padStart(3)} / ${String(r.ok).padStart(3)} / ${r.hj}`);

console.log("\n[YIELD SURFACE]");
const total = num("SELECT COUNT(*) n FROM companies");
const prod = num("SELECT COUNT(*) n FROM companies WHERE COALESCE(postings_matched_total,0)>0");
console.log(`  ever matched (productive): ${prod} / ${total} (${((prod / total) * 100).toFixed(1)}%)`);
console.log("  ever saw a job:", num("SELECT COUNT(*) n FROM companies WHERE COALESCE(postings_seen_total,0)>0"));

console.log("\n[INVESTIGATE — telemetry signals, NOT removal criteria]");
console.log("  reachable but 0 jobs ever:", num("SELECT COUNT(*) n FROM companies WHERE last_success_at IS NOT NULL AND COALESCE(postings_seen_total,0)=0"));
console.log("  never succeeded:", num("SELECT COUNT(*) n FROM companies WHERE last_fetched_at IS NOT NULL AND last_success_at IS NULL"));
console.log("  never fetched:", num("SELECT COUNT(*) n FROM companies WHERE last_fetched_at IS NULL"));
console.log("  url_suspect=1:", num("SELECT COUNT(*) n FROM companies WHERE url_suspect=1"));
console.log("  consecutive_failures>=3:", num("SELECT COUNT(*) n FROM companies WHERE COALESCE(consecutive_failures,0)>=3"));

// Went-quiet: a board that once produced postings and now answers N clean fetches with zero
// rows is the dead-tenant false-pass signature (200 + empty list while the company hires
// elsewhere). Surfaced here for repoint research instead of rotting silently.
console.log("\n[WENT QUIET]  active, saw postings before, >=3 consecutive zero-yield fetches");
const quietRow = z.object({ provider: z.string(), slug: z.string(), name: z.string(), zy: z.number(), seen: z.number() });
const quiet = query(
  `SELECT provider, slug, name, zero_yield_streak zy, postings_seen_total seen
     FROM companies
    WHERE status='active' AND zero_yield_streak >= 3 AND postings_seen_total > 0
    ORDER BY postings_seen_total DESC`,
  quietRow,
);
if (quiet.length === 0) console.log("  (none)");
for (const r of quiet) {
  console.log(`  ${(r.provider + "/" + r.slug).padEnd(40)} quiet x${r.zy}, ${r.seen} postings seen historically — probably moved boards`);
}

console.log("\n[POSTINGS REMOVED — last 7 days, per profile]");
const removedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const removedRow = z.object({ profile_id: z.string(), n: z.number() });
const removed = query(
  `SELECT profile_id, COUNT(*) n FROM postings
    WHERE removed_at IS NOT NULL AND removed_at >= '${removedCutoff}'
    GROUP BY profile_id ORDER BY n DESC`,
  removedRow,
);
if (removed.length === 0) console.log("  (none)");
for (const r of removed) console.log(`  ${r.profile_id.padEnd(16)} ${r.n}`);

console.log("\n[BOARD CHURN]  top 10 boards by added+removed, summed over their last 5 fetches");
const churnRow = z.object({ provider: z.string(), company_slug: z.string(), churn: z.number() });
const churn = query(
  `WITH ranked AS (
     SELECT provider, company_slug, added, removed,
            ROW_NUMBER() OVER (PARTITION BY provider, company_slug ORDER BY run_at DESC) rn
     FROM board_runs
   )
   SELECT provider, company_slug, SUM(added + removed) churn
   FROM ranked
   WHERE rn <= 5
   GROUP BY provider, company_slug
   ORDER BY churn DESC
   LIMIT 10`,
  churnRow,
);
if (churn.length === 0) console.log("  (none)");
for (const r of churn) console.log(`  ${(r.provider + "/" + r.company_slug).padEnd(40)} ${r.churn}`);

// Reads the local snapshot rather than the sheet - this report is a point-in-time cross-check, not a live sync.
const regPath = resolve(process.cwd(), config.storage.registryPath);
if (existsSync(regPath)) {
  const reg = z
    .array(z.object({ category: z.string().optional(), employer_type: z.string().optional() }))
    .parse(JSON.parse(readFileSync(regPath, "utf-8")));
  const tally = (key: "category" | "employer_type"): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const c of reg) {
      const k = c[key] ?? "(unset)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log("\n[CATEGORY] (from registry cache)");
  for (const [cat, cnt] of tally("category")) console.log(`  ${cat.padEnd(24)} ${cnt}`);
  console.log("\n[EMPLOYER TYPE]");
  for (const [et, cnt] of tally("employer_type")) console.log(`  ${et.padEnd(12)} ${cnt}`);
} else {
  console.log("\n[CATEGORY / EMPLOYER TYPE] no local cache yet — run `npm run once` first.");
}

process.exit(0);
