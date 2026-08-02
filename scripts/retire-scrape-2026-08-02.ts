/**
 * Phase 5c/5d retirements: scrape rows with no machine-readable board.
 *
 * Two groups, one pass:
 *
 *  A. TASK 12b — 20 boards researched individually on 2026-08-01 (browser render + XHR
 *     capture + 27-vendor engine fingerprint). Each has a per-company finding recorded
 *     below. 18 have no board at all; the other 2 are duplicates of a producing row.
 *
 *  B. TASK 12c — every remaining `dormant` scrape row. Owner decision 2026-08-02: a weekly
 *     recheck of a page with no parseable jobs returns nothing forever. Three independent
 *     methods (derived-domain probing across 29 vendors, homepage careers-link crawling,
 *     WebSearch of confirmed careers URLs) found no board for this cohort.
 *
 * `broken` not `denied`: denied is the owner's column, set by hand, meaning "I have decided
 * to exclude this company". Everything here is technical — "we cannot fetch this".
 *
 * NOTE ON A SEPARATE COHORT: the plan also listed 34 "domain-dead" rows for retirement.
 * They are NOT here. Re-probed 2026-08-02 with the cause chain exposed, not one was dead —
 * the "tiny page 114b" rows are all the same JS redirect stub on live sites (Gameskraft
 * among them), the 403s serve real content (Nestle India: 40,683 bytes), and the "DNS
 * failures" were the opaque `TypeError: fetch failed` masking an expired certificate, a
 * certificate altname mismatch, and connect timeouts. Those are repairs, not deaths.
 *
 * Run: `npx tsx scripts/retire-scrape-2026-08-02.ts`          (dry run)
 *      `npx tsx scripts/retire-scrape-2026-08-02.ts --apply`
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";
import { readTab } from "../src/google/sheets.js";
import { googleFetchJson, requireSpreadsheetId } from "../src/google/rest.js";

const PROFILE = "vikrant";
const TAB = config.google.tabs.companies;

/** Group A — individually researched, exact finding recorded. */
const RESEARCHED: Record<string, string> = {
  "Voot": "merged into Hotstar (voot.com -> hotstar.com); duplicate of workday/jiostar (active, 2842 postings)",
  "Disney+ Hotstar": "merged into JioStar; duplicate of workday/jiostar (active, 2842 postings)",
  "Tripeur": "acquired by Navan (tripeur.com -> navan.com); no board",
  "Tagbox": "page states 'This domain has been acquired by Taggbox'; no board",
  "OkCredit": "-> okcredit.in, no jobs",
  "Mensa Brands": "-> brndme.in, no jobs",
  "Agilitas": "-> agilitas.com/pages/careers; jobs live in a Shopify CDN JS asset whose path changes on every theme deploy - one bespoke parser for one company, not worth an adapter",
  "PokerBaazi": "-> pokerbaazi.net, 'Free2Play is no longer available'",
  "Frontrow": "-> a Medium apology post; company wound down",
  "Supr Daily": "DOMAIN HIJACKED - now serves keluarantotomacau.it.com, a gambling/spam site. Was being fetched with a headless browser every run",
  "Rocketium": "/careers -> 404",
  "Verloop": "careers.verloop.io redirects to a login page; board is auth-walled",
  "Craze": "-> craze.ai, no jobs",
  "FabAlley": "-> houseofindya.com, no jobs",
};

const GROUP_C_REASON =
  "no machine-readable board found by derived-domain probe (29 vendors), homepage careers-link crawl, " +
  "or WebSearch of the confirmed careers URL. Company may well be alive; openings distributed via " +
  "aggregators or an internal portal. Revisit if they publish a real board.";

/** Never retire these even if they match the dormant-scrape sweep. */
const PROTECTED = new Set<string>([
  "Tickertape", "Niki.ai", // converted to freshteam; reachable boards that are simply empty today
  "Square Yards",          // its JSON API works; a Phase 5 adapter serves it

  // Task 11b/11d candidates: a prior pass found a probable ATS engine and surface for each,
  // and they are being validated through their adapters right now. Retiring a row that is
  // about to be converted would mean un-retiring it minutes later, so they wait.
  "Chargebee", "ChargeBee Inc", "Mankind Pharma", "Mahindra Electric", "Mahindra Logistics",
  "Infineon India", "Tracxn", "Lyzr AI", "Stellapps Technologies", "IDfy", "purplle",
  "Orange Health Labs", "Matrimony.com", "Zest Money", "Yulu Bikes", "Emergent",
  "ICICI Direct", "Westside India", "Toyota Kirloskar Motor", "Treebo Hotels", "Salesken",
  "Engati", "Loco", "MoneyTap", "Bajaj Allianz", "Bandhan Bank", "99acres", "InfoEdge (Naukri)",
  "MaxLinear India", "Societe Generale India",
]);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = new DatabaseSync("data/job_hunter.db", { readOnly: true });

  // Group A: named rows, any non-ats-api strategy, in a status we are allowed to change.
  // Group B: every remaining dormant scrape row.
  const rows = db.prepare(`
    SELECT name, provider, slug, status, parsing_strategy ps, postings_seen_total pst
    FROM companies
    WHERE parsing_strategy <> 'ats-api' AND status IN ('active','dormant')
    ORDER BY postings_seen_total DESC, name
  `).all().map((r) => ({
    name: typeof r.name === "string" ? r.name : "",
    provider: typeof r.provider === "string" ? r.provider : "",
    slug: typeof r.slug === "string" ? r.slug : "",
    status: typeof r.status === "string" ? r.status : "",
    ps: typeof r.ps === "string" ? r.ps : "",
    pst: typeof r.pst === "number" ? r.pst : 0,
  }));

  const targets = rows.filter((r) => !PROTECTED.has(r.name));
  const skipped = rows.filter((r) => PROTECTED.has(r.name));
  for (const s of skipped) console.log(`  PROTECTED  ${s.name} — left alone`);

  // Any row that ever produced postings deserves a second look before being written off.
  const producedBefore = targets.filter((r) => r.pst > 0);
  if (producedBefore.length > 0) {
    console.log(`\n  ${producedBefore.length} row(s) have produced postings before — listing for eyeball:`);
    for (const p of producedBefore) console.log(`     pst=${String(p.pst).padStart(5)}  ${p.name.padEnd(30)} ${p.provider}/${p.slug} [${p.status}]`);
  }

  const sheet = await readTab(PROFILE, TAB);
  const header = sheet[0] ?? [];
  const idx = (n: string): number => header.indexOf(n);
  const letter = (i: number): string => String.fromCharCode(65 + i);
  const cName = idx("name");
  const cStatus = idx("status");
  const cReason = idx("reason");

  const data: { range: string; values: string[][] }[] = [];
  let researched = 0;
  let swept = 0;
  let unresolved = 0;

  for (const t of targets) {
    const hits = sheet.map((r, i) => ({ r, i })).filter((x) => x.i > 0 && (x.r[cName] ?? "").trim() === t.name);
    if (hits.length !== 1) { unresolved++; continue; }
    const hit = hits[0];
    if (hit === undefined) { unresolved++; continue; }
    const sr = hit.i + 1;

    const specific = RESEARCHED[t.name];
    if (specific !== undefined) researched++; else swept++;
    const note = `retired 2026-08-02 -> broken: ${specific ?? GROUP_C_REASON}`;
    const prior = (hit.r[cReason] ?? "").trim();

    data.push({ range: `${TAB}!${letter(cStatus)}${sr}`, values: [["broken"]] });
    data.push({ range: `${TAB}!${letter(cReason)}${sr}`, values: [[prior.length > 0 ? `${prior} | ${note}` : note]] });
  }

  console.log(`\n${researched} individually-researched + ${swept} dormant-scrape sweep = ${researched + swept} retirements`);
  console.log(`${data.length} cells, ${unresolved} unresolved (name not unique on the tab)`);
  const named = Object.keys(RESEARCHED).filter((n) => !targets.some((t) => t.name === n));
  if (named.length > 0) console.log(`note: ${named.length} researched name(s) not in the target set (already retired or renamed): ${named.join(", ")}`);

  if (!apply) { console.log("\nDRY RUN — re-run with --apply"); return; }

  // Sheets caps a single batchUpdate; chunk generously below any practical limit.
  const CHUNK = 200;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${requireSpreadsheetId()}/values:batchUpdate`;
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.slice(i, i + CHUNK);
    await googleFetchJson(PROFILE, url, { method: "POST", body: { valueInputOption: "RAW", data: slice } });
    console.log(`  wrote cells ${i + 1}-${i + slice.length}`);
  }

  // `broken` is sticky against sheet sync, which also means the sheet alone cannot set it.
  const wdb = new DatabaseSync("data/job_hunter.db");
  wdb.exec("PRAGMA busy_timeout=5000");
  const stmt = wdb.prepare("UPDATE companies SET status='broken' WHERE name=? AND status IN ('active','dormant')");
  let changed = 0;
  for (const t of targets) changed += Number(stmt.run(t.name).changes);
  console.log(`db: ${changed} rows set to broken`);
}

await main();
