/**
 * Apply the validated scrape -> ats-api conversions to the Companies tab.
 *
 * Plan: docs/superpowers/plans/2026-08-01-scrape-to-ats-conversion.md (Tasks 5/6).
 * Every target below was verified live before being listed: board reachable, identity
 * matches the company, real Indian locations.
 *
 * Two deliberate departures from the plan's sketch:
 *
 *  1. CELL-LEVEL WRITES, not `updateRegistryEntry`. That helper rewrites the whole row
 *     A:N, which is how an owner-authored `reason` cell was destroyed on 2026-07-27. We
 *     touch exactly six columns and never `reason` (G).
 *  2. The conversion note goes in `evidence` (J, tool-authored provenance) instead of
 *     `reason` (G, where the owner writes). The plan's sketch set `reason`, which would
 *     have overwritten owner text while claiming to preserve it.
 *
 * All writes go up in ONE values:batchUpdate — one request per cell blows the Sheets
 * 60-writes-per-minute-per-user quota well before 200 cells.
 *
 * Run: `npx tsx scripts/apply-conversions-2026-08-02.ts`          (dry run)
 *      `npx tsx scripts/apply-conversions-2026-08-02.ts --apply`  (writes)
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { readTab } from "../src/google/sheets.js";
import { googleFetchJson, requireSpreadsheetId } from "../src/google/rest.js";

const PROFILE = "vikrant"; // the profile whose Google token is present
const TAB = config.google.tabs.companies;

export interface Conversion {
  /** Exact `name` cell — the registry key includes it, and some carry odd
   *  punctuation ("Statiq." has a trailing period) that must match verbatim. */
  name: string;
  to: { source: string; source_slug: string; careers_url: string; tenant_url?: string };
  evidence: string;
}

const ats = (source: string, slug: string, url: string, evidence: string, tenant?: string): Conversion => ({
  name: "",
  to: { source, source_slug: slug, careers_url: url, ...(tenant === undefined ? {} : { tenant_url: tenant }) },
  evidence,
});
const named = (name: string, c: Conversion): Conversion => ({ ...c, name });

/**
 * Bajaj Finserv is deliberately ABSENT. Its deny_reason reads "denied 2026-07-15 (owner
 * call): legacy Indian conglomerate / old-economy - weak tech culture for our roles", but
 * its status had drifted to `dormant` — so the plan's `status === 'denied'` gate would
 * have missed it and resurrected a company the owner rejected by hand. The owner-deny
 * gate below now checks deny_reason text as well as status.
 *
 * Capillary AI is also absent by design: it resolves to the same trakstar/capillary board
 * as Capillary Technologies, so it is a retirement (Task 12), not a conversion.
 */
export const CONVERSIONS: Conversion[] = [
  // --- identity re-probe, confirmed Indian locations ---
  named("fold.money", ats("zohorecruit", "fold", "https://fold.zohorecruit.com/jobs/Careers", "7 India roles")),
  named("CaratLane", ats("ripplehire", "caratlane", "https://caratlane.ripplehire.com", "4 India roles", "https://caratlane.ripplehire.com")),
  named("MyGlamm", ats("freshteam", "myglamm", "https://myglamm.freshteam.com/jobs", "4 India roles")),
  named("Exly", ats("freshteam", "exly", "https://exly.freshteam.com/jobs", "3 India roles")),
  named("LotusPay", ats("freshteam", "lotuspay", "https://lotuspay.freshteam.com/jobs", "3 India roles")),
  named("Lybrate", ats("trakstar", "lybrate", "https://lybrate.hire.trakstar.com", "3 India roles")),
  named("Onsurity", ats("zohorecruit", "onsurity", "https://onsurity.zohorecruit.com/jobs/Careers", "3 India roles")),
  named("Skill-lync", ats("smartrecruiters", "skill-lync", "https://careers.smartrecruiters.com/skill-lync", "3 India roles")),
  named("Vedantu", ats("zohorecruit", "vedantu", "https://vedantu.zohorecruit.com/jobs/Careers", "2 India roles")),
  named("Bharat Forge", ats("freshteam", "bharatforge", "https://bharatforge.freshteam.com/jobs", "2 India roles")),
  named("Capillary Technologies", ats("trakstar", "capillary", "https://capillary.hire.trakstar.com", "2 India roles")),
  named("Decentro", ats("keka", "decentro", "https://decentro.keka.com/careers", "2 India roles")),
  named("Bennett Coleman", ats("trakstar", "timesgroup", "https://timesgroup.hire.trakstar.com", "1 India role")),
  named("HROne", ats("trakstar", "hrone", "https://hrone.hire.trakstar.com", "1 India role")),
  named("IndusInd Bank", ats("ripplehire", "indusind", "https://indusind.ripplehire.com", "1 India role", "https://indusind.ripplehire.com")),
  named("Statiq.", ats("smartrecruiters", "statiq", "https://careers.smartrecruiters.com/statiq", "1 India role")),
  named("BankBazaar", ats("trakstar", "bankbazaar", "https://bankbazaar.hire.trakstar.com", "1 India role")),
  named("FreightFox", ats("keka", "freightfox", "https://freightfox.keka.com/careers", "1 India role")),
  named("MoonFrog Labs", ats("trakstar", "moonfroglabs", "https://moonfroglabs.hire.trakstar.com", "1 India role")),
  named("Unschool", ats("smartrecruiters", "unschool", "https://careers.smartrecruiters.com/unschool", "1 India role")),
  named("Sukoon Health", ats("freshteam", "sukoonhealth", "https://sukoonhealth.freshteam.com/jobs", "1 India role (Gurgaon)")),

  // --- page-content grind, adapter-validated ---
  named("HDFC Bank", ats("ripplehire", "hdfcbank", "https://hdfcbank.ripplehire.com", "234 posts, 121 India, JD 2409ch", "https://hdfcbank.ripplehire.com")),
  // Symantec India and PopXO Money (Pop) were BOTH in this list until the collision gate
  // caught them: each targets a board an existing producing row already owns, at a
  // byte-identical careers_url.
  //   Symantec India     -> workday/broadcom  = Pivotal Labs India (active, pst=7736)
  //   PopXO Money (Pop)  -> keka/popclub      = POP (Poptech Growth) (active, pst=50)
  // Symantec and Pivotal both landed inside Broadcom, so one Broadcom board serves both.
  // These are duplicates to retire (Task 12), not conversions — converting them would
  // have fetched the same board twice under two names. This is the JioStar case exactly.
  named("Goodera", ats("kula", "goodera", "https://goodera.kula.ai", "20 India roles")),
  named("SaaS Labs", ats("kula", "saas-labs", "https://saas-labs.kula.ai", "18 India roles")),
  named("WizCommerce", ats("kula", "wizcommerce", "https://wizcommerce.kula.ai", "12 India roles")),
  named("Kutumb", ats("keka", "primetrace", "https://primetrace.keka.com/careers", "11 India roles")),
  named("PingCAP India", ats("greenhouse", "pingcap", "https://boards.greenhouse.io/pingcap", "7 India roles")),
  named("Testsigma", ats("keka", "testsigma", "https://testsigma.keka.com/careers", "7 India roles")),
  named("Tata CLiQ", ats("darwinbox", "cliqonnect", "https://cliqonnect.darwinbox.in/ms/candidate/careers", "4 India roles", "https://cliqonnect.darwinbox.in")),
  named("Uniqode", ats("kula", "uniqode", "https://uniqode.kula.ai", "1 India role")),

  // --- reachable but currently EMPTY boards: convert anyway ---
  // A reachable ATS board with 0 postings beats scraping a page with 0 postings: one cheap
  // API call instead of a browser render, and it produces the moment they post. These are
  // NOT retirements — `broken` is only for boards we cannot read at all.
  named("Tickertape", ats("freshteam", "tickertape", "https://tickertape.freshteam.com/jobs", "board reachable, 0 postings at validation")),
  named("Niki.ai", ats("freshteam", "niki-talent", "https://niki-talent.freshteam.com/jobs", "board reachable, 0 postings at validation")),
];

/* ===== owner-deny gate ===== */

const db = new DatabaseSync("data/job_hunter.db", { readOnly: true });

/** Owner-authored deny markers. Status alone is not enough: Bajaj Finserv carried an
 *  explicit owner call in deny_reason while its status had drifted to `dormant`. */
const OWNER_DENY_RE = /owner call|owner-denied|\(owner/i;

interface Existing { status: string; denyReason: string; provider: string; slug: string }

function lookup(name: string): Existing | null {
  const row = db.prepare("SELECT status, deny_reason, provider, slug FROM companies WHERE name = ?").get(name);
  if (row === undefined) return null;
  return {
    status: typeof row.status === "string" ? row.status : "",
    denyReason: typeof row.deny_reason === "string" ? row.deny_reason : "",
    provider: typeof row.provider === "string" ? row.provider : "",
    slug: typeof row.slug === "string" ? row.slug : "",
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const rows = await readTab(PROFILE, TAB);
  const header = rows[0] ?? [];
  const idx = (n: string): number => header.indexOf(n);
  const cName = idx("name");
  const cReason = idx("reason");
  const cEvidence = idx("evidence");
  // Column letters are derived, not hardcoded, so a future column insert can't silently
  // send these writes to the wrong field.
  const letter = (i: number): string => String.fromCharCode(65 + i);
  for (const [label, i] of [["name", cName], ["careers_url", idx("careers_url")], ["source", idx("source")],
    ["source_slug", idx("source_slug")], ["parsing_strategy", idx("parsing_strategy")], ["status", idx("status")],
    ["tenant_url", idx("tenant_url")], ["evidence", cEvidence]] as const) {
    if (i < 0) { console.error(`ABORT: column '${label}' not found on the tab`); process.exit(1); }
  }

  const data: { range: string; values: string[][] }[] = [];
  let skipped = 0;
  let missing = 0;
  let queued = 0;

  for (const c of CONVERSIONS) {
    const ex = lookup(c.name);
    if (ex === null) { console.log(`  MISSING   ${c.name} — no registry row`); missing++; continue; }
    if (ex.status === "denied" || OWNER_DENY_RE.test(ex.denyReason)) {
      console.log(`  SKIP      ${c.name} — owner-denied (${ex.status}): ${ex.denyReason.slice(0, 70)}`);
      skipped++;
      continue;
    }

    const sheetIdx = rows.findIndex((r, i) => i > 0 && (r[cName] ?? "").trim() === c.name);
    if (sheetIdx < 0) { console.log(`  MISSING   ${c.name} — no sheet row`); missing++; continue; }
    const dupes = rows.filter((r, i) => i > 0 && (r[cName] ?? "").trim() === c.name).length;
    if (dupes > 1) { console.log(`  AMBIGUOUS ${c.name} — ${dupes} sheet rows share this name; resolve by hand`); missing++; continue; }
    const sr = sheetIdx + 1;

    const priorEvidence = (rows[sheetIdx]?.[cEvidence] ?? "").trim();
    const note = `converted 2026-08-02 scrape->ats-api: ${c.evidence}`;
    const evidence = priorEvidence.length > 0 ? `${priorEvidence} | ${note}` : note;

    const put = (col: number, v: string): void => { data.push({ range: `${TAB}!${letter(col)}${sr}`, values: [[v]] }); };
    put(idx("careers_url"), c.to.careers_url);
    put(idx("source"), c.to.source);
    put(idx("source_slug"), c.to.source_slug);
    put(idx("parsing_strategy"), "ats-api");
    put(idx("status"), "active");
    put(idx("tenant_url"), c.to.tenant_url ?? "");
    put(cEvidence, evidence);
    // reason (column G) is deliberately never written.

    queued++;
    const prior = (rows[sheetIdx]?.[cReason] ?? "").trim();
    console.log(
      `  row ${String(sr).padStart(5)}  ${c.name.padEnd(24)} ${ex.provider}/${ex.slug} -> ${c.to.source}/${c.to.source_slug}` +
      `  [${ex.status} -> active]${prior.length > 0 ? "  (reason preserved)" : ""}`,
    );
  }

  console.log(`\nqueued ${queued} conversions (${data.length} cells), skipped ${skipped} owner-denied, ${missing} unresolved`);

  if (!apply) { console.log("DRY RUN — re-run with --apply"); return; }
  if (missing > 0) { console.error("Refusing to write while rows are unresolved — fix them first."); process.exit(1); }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${requireSpreadsheetId()}/values:batchUpdate`;
  const resp = await googleFetchJson(PROFILE, url, { method: "POST", body: { valueInputOption: "RAW", data } });
  console.log("batchUpdate:", JSON.stringify(resp).slice(0, 200));
}

// Only run when invoked directly. check-conversion-collisions.ts imports CONVERSIONS from
// this module, and a bare top-level `await main()` would make that import perform a sheet
// read and print a full dry run as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
