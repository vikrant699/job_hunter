/**
 * Retire rows to `broken` — technical retirements only.
 *
 * `denied` is the owner's column: it means "I have decided to exclude this company" and is
 * only ever set by hand on the Companies tab. Anything we retire because we cannot fetch it
 * goes to `broken`. Both are excluded from selectActiveCompanies, so this costs nothing
 * functionally and keeps `denied` a truthful record of the owner's decisions.
 *
 * A row may only appear here on POSITIVE evidence:
 *   DUPLICATE  — another registry row already covers the same board (named below)
 *   NO-BOARD   — exhaustively searched, no machine-readable board exists
 *
 * "My probe did not find a board" is NOT grounds. Neither is HTTP 403, a JS-redirect stub,
 * or an opaque `TypeError: fetch failed`.
 *
 * WHY THE PLAN'S 34 "DOMAIN-DEAD" ROWS ARE ABSENT
 * -----------------------------------------------
 * Re-probed 2026-08-02 with the cause chain exposed (src/util/error-cause.ts). Not one of
 * the 34 survived scrutiny:
 *   - 8 "tiny page 114b" rows are the SAME JS redirect stub
 *     (`window.location.href="/lander"`). Live sites, client-side redirect. Gameskraft is
 *     among them, and TrueFan AI now serves 20,569 bytes outright.
 *   - "parked/for-sale" Reclaim Protocol returns a real 3,141-byte page; MedPiper's "404"
 *     is now a 200.
 *   - 10 HTTP 403s serve real content (Nestle India: 40,683 bytes) — WAF blocks, fixed by
 *     hand, not deaths.
 *   - The 11 read as "DNS dead" were the opaque `TypeError: fetch failed`. With causes
 *     visible they are: expired certificate (Pristyn Care), certificate altname mismatch
 *     (Sumtotal), and connect timeouts (Suzlon, Outplay, Suryoday). Repairs, not deaths.
 * Those rows stay parked `dormant`: cheap, and still in the weekly recheck.
 *
 * Run: `npx tsx scripts/retire-2026-08-02.ts`          (dry run)
 *      `npx tsx scripts/retire-2026-08-02.ts --apply`
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";
import { readTab } from "../src/google/sheets.js";
import { googleFetchJson, requireSpreadsheetId } from "../src/google/rest.js";

const PROFILE = "vikrant";
const TAB = config.google.tabs.companies;

interface Retirement { name: string; why: string }

const RETIREMENTS: Retirement[] = [
  // --- duplicates: the board works, we just do not need a second row ---
  { name: "Citi India GCC", why: "duplicate of workday/citi (Citi India, active, 19398 postings)" },
  { name: "Symantec India", why: "duplicate of workday/broadcom (Pivotal Labs India, active, 7736 postings) — Symantec and Pivotal both sit inside Broadcom, one board serves both" },
  { name: "Amazon", why: "duplicate of amazonjobs/amazon (Amazon India, active, 10512 postings)" },
  { name: "PopXO Money (Pop)", why: "duplicate of keka/popclub (POP (Poptech Growth), active, 50 postings)" },
  { name: "Capillary AI", why: "duplicate of trakstar/capillary (Capillary Technologies) — same board" },
  { name: "LinkedIn Learning India", why: "duplicate of custom/linkedin-india — identical careers_url https://careers.linkedin.com/" },

  // --- no machine-readable board exists (each exhaustively searched 2026-08-02) ---
  { name: "MFine", why: "no board: mfine.darwinbox.in returns 'Error while getting tenant info' (legacy + candidatev2); mfine.co/careers 404; no career links on the site; 12-provider sweep empty" },
  { name: "Rooter Sports", why: "no board: rooter.darwinbox.in returns 'Invalid subdomain: rooter' (tenant never existed); rooter.gg/careers 404; 367-URL sitemap has zero career pages; 12-provider sweep empty" },
  { name: "Unocoin", why: "no board: unocoin.recruitee.com 302s to Recruitee marketing (no tenant), /api/offers/ 404; unocoin.com career routes all 404; both sitemaps and llms.txt have zero career URLs" },
  { name: "Kroger India", why: "no board AND the registered URL is wrong: kroger.eightfold.ai serves EIGHTFOLD INC's own jobs (incl. real Bengaluru/Noida roles), not Kroger's — Kroger is not an Eightfold tenant. Kroger's real board is Oracle CX_2001, which has no India roles. Left active it would ingest Eightfold's jobs as Kroger's" },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const rows = await readTab(PROFILE, TAB);
  const header = rows[0] ?? [];
  const idx = (n: string): number => header.indexOf(n);
  const letter = (i: number): string => String.fromCharCode(65 + i);
  const cName = idx("name");
  const cStatus = idx("status");
  const cReason = idx("reason");
  for (const c of ["name", "status", "reason"]) {
    if (idx(c) < 0) { console.error(`ABORT: column '${c}' missing`); process.exit(1); }
  }

  const db = new DatabaseSync("data/job_hunter.db", { readOnly: true });
  const data: { range: string; values: string[][] }[] = [];
  let unresolved = 0;

  for (const r of RETIREMENTS) {
    const hits = rows.map((row, i) => ({ row, i })).filter((x) => x.i > 0 && (x.row[cName] ?? "").trim() === r.name);
    if (hits.length !== 1) {
      console.log(`  UNRESOLVED  ${r.name} — ${hits.length} sheet rows match`);
      unresolved++;
      continue;
    }
    const sheetRow = (hits[0]?.i ?? 0) + 1;

    // Never let a technical retirement stomp an owner decision.
    const cur = db.prepare("SELECT status FROM companies WHERE name = ?").get(r.name);
    const curStatus = cur !== undefined && typeof cur.status === "string" ? cur.status : "(absent)";
    if (curStatus === "denied") {
      console.log(`  SKIP        ${r.name} — already owner-denied, leaving it alone`);
      continue;
    }

    // Append to reason; the owner writes in this column and must never lose text.
    const prior = (hits[0]?.row[cReason] ?? "").trim();
    const note = `retired 2026-08-02 -> broken: ${r.why}`;
    data.push({ range: `${TAB}!${letter(cStatus)}${sheetRow}`, values: [["broken"]] });
    data.push({ range: `${TAB}!${letter(cReason)}${sheetRow}`, values: [[prior.length > 0 ? `${prior} | ${note}` : note]] });
    console.log(`  row ${String(sheetRow).padStart(5)}  ${r.name.padEnd(24)} ${curStatus} -> broken${prior.length > 0 ? "  (reason appended)" : ""}`);
  }

  console.log(`\n${data.length / 2} retirements queued (${data.length} cells), ${unresolved} unresolved`);
  if (!apply) { console.log("DRY RUN — re-run with --apply"); return; }
  if (unresolved > 0) { console.error("Refusing to write with unresolved rows."); process.exit(1); }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${requireSpreadsheetId()}/values:batchUpdate`;
  console.log("sheet:", JSON.stringify(await googleFetchJson(PROFILE, url, { method: "POST", body: { valueInputOption: "RAW", data } })).slice(0, 170));

  // The DB half: `broken` is sticky against sheet sync (a re-import must never revive a
  // quarantined board), which also means the sheet alone cannot SET it. Write it directly.
  const wdb = new DatabaseSync("data/job_hunter.db");
  wdb.exec("PRAGMA busy_timeout=5000");
  const stmt = wdb.prepare("UPDATE companies SET status='broken' WHERE name=? AND status<>'denied'");
  let changed = 0;
  // `changes` is number | bigint on this driver.
  for (const r of RETIREMENTS) changed += Number(stmt.run(r.name).changes);
  console.log(`db: ${changed} rows set to broken`);
}

await main();
