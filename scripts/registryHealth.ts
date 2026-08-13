/**
 * Registry health report (read-only). The before/after yardstick for the
 * denoise + expansion effort (plan: docs/superpowers/plans/2026-06-19-...).
 *
 * Run: `node --import tsx scripts/registryHealth.ts`
 *
 * NOTE: yield telemetry here is a PRIORITIZATION signal (who to investigate),
 * NOT a removal criterion. Removal requires positive evidence a company is not
 * a tech employer in India (see the plan's §9 noise definition).
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

// Category / employer_type live on the Companies tab (source of truth, Phase 3);
// Went-quiet detector: a board that once produced postings and has now
// answered N clean fetches with zero rows is the dead-tenant false-pass
// signature (the ATS answers 200 with an empty list while the company hires
// on a NEW board — 77 such rows found in the 2026-08-13 sweep, 17 of them
// repointable). Surface them for repoint research instead of letting them
// rot silently.
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

// this reads the local snapshot (data/registry-cache.json) rather than hitting
// the sheet, since this report is a point-in-time DB/cache cross-check, not a
// live sync.
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
