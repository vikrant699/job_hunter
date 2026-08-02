/**
 * Required gate before applying any conversion (plan Task 6, step 2).
 *
 * Why this exists: `Disney+ Hotstar` sat in an earlier conversion list aiming at
 * jiostar.com while `workday/jiostar` already existed, `active`, with 2,842 postings.
 * It was caught by eye, not by a check. Four rows existed for one company.
 *
 * Three collision classes must all come back empty:
 *   1. the target provider/slug is already held by a DIFFERENT company
 *   2. two conversions aim at the same board
 *   3. an existing PRODUCING ats-api row looks like the same company under any provider
 *
 * Class 3 is deliberately noisy — it surfaces name-similar rows for a human to judge
 * ("Capillary Technologies" vs "Capillary AI" is a real pair; "Tata CLiQ" vs "Tata Motors"
 * is not). Resolve every flag by hand; never suppress one.
 *
 * Run: `npx tsx scripts/check-conversion-collisions.ts`
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { CONVERSIONS } from "./apply-conversions-2026-08-02.js";

const db = new DatabaseSync("data/job_hunter.db", { readOnly: true });

/** Strip the corporate noise that makes two rows for one employer look distinct. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\b(india|gcc|ltd|limited|pvt|private|inc|technologies|technology|tech|labs|group|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

interface Row { provider: string; slug: string; name: string; status: string; ps: string; pst: number }

const existing: Row[] = db
  .prepare("SELECT provider, slug, name, status, parsing_strategy ps, postings_seen_total pst FROM companies")
  .all()
  .map((r) => ({
    provider: typeof r.provider === "string" ? r.provider : "",
    slug: typeof r.slug === "string" ? r.slug : "",
    name: typeof r.name === "string" ? r.name : "",
    status: typeof r.status === "string" ? r.status : "",
    ps: typeof r.ps === "string" ? r.ps : "",
    pst: typeof r.pst === "number" ? r.pst : 0,
  }));

/**
 * Class-3 pairs a human has examined and judged NOT the same company. Recorded here rather
 * than fixed by loosening `norm`, so the judgement stays visible and re-running the gate
 * still means something. Keyed `conversion name :: existing provider/slug`.
 *
 * CaratLane vs Atlan: pure substring coincidence — norm("CaratLane") is "caratlane", which
 * contains "atlan". CaratLane is Titan's jewellery arm; Atlan is a data-catalog company.
 */
const ACKNOWLEDGED_NOT_SAME: Record<string, string> = {
  "CaratLane :: ashby/atlan": "substring coincidence; unrelated companies (verified 2026-08-02)",
};

let bad = 0;
let acknowledged = 0;

console.log(`checking ${CONVERSIONS.length} conversions against ${existing.length} registry rows\n`);

// 1. target provider/slug already taken by a different company
for (const c of CONVERSIONS) {
  const hit = existing.find((e) => e.provider === c.to.source && e.slug === c.to.source_slug && e.name !== c.name);
  if (hit) {
    console.log(`COLLISION      ${c.name} -> ${c.to.source}/${c.to.source_slug} is already ${hit.name} (${hit.status}, pst=${hit.pst})`);
    bad++;
  }
}

// 2. two conversions aiming at the same board
const seen = new Map<string, string>();
for (const c of CONVERSIONS) {
  const k = `${c.to.source}/${c.to.source_slug}`;
  const prev = seen.get(k);
  if (prev !== undefined) {
    console.log(`COLLISION      ${c.name} and ${prev} both target ${k}`);
    bad++;
  } else seen.set(k, c.name);
}

// 3. an existing PRODUCING ats-api row for what looks like the same company
for (const c of CONVERSIONS) {
  const n = norm(c.name);
  if (n.length < 4) continue;
  for (const e of existing) {
    if (e.name === c.name || e.ps !== "ats-api" || e.pst === 0) continue;
    const m = norm(e.name);
    if (m.length < 4) continue;
    if (n === m || n.includes(m) || m.includes(n)) {
      const ack = ACKNOWLEDGED_NOT_SAME[`${c.name} :: ${e.provider}/${e.slug}`];
      if (ack !== undefined) {
        console.log(`ack          ${c.name} vs ${e.name} — ${ack}`);
        acknowledged++;
        continue;
      }
      console.log(`SAME-COMPANY?  ${c.name} -> ${c.to.source}/${c.to.source_slug}   vs existing ${e.name} (${e.provider}/${e.slug}, ${e.status}, pst=${e.pst})`);
      bad++;
    }
  }
}

if (acknowledged > 0) console.log(`\n${acknowledged} class-3 flag(s) previously judged not-same-company`);
console.log(bad === 0 ? "no unresolved collisions — safe to apply" : `\n${bad} collision(s) — RESOLVE BEFORE APPLYING`);
process.exit(bad === 0 ? 0 : 1);
