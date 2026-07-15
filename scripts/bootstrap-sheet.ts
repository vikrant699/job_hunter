/**
 * One-time (idempotent) bootstrap of the outreach spreadsheet:
 *   - creates the bot-managed tabs (Raw Data, Drafts, Sent, Undrafted, Companies)
 *   - uploads config/recruiters-raw.csv into Raw Data (only when the tab is empty)
 *   - uploads data/registry-cache.json into Companies (only when the tab is
 *     empty AND a local cache already exists — a brand-new setup with no
 *     cache yet leaves the Companies tab for the user to seed by hand)
 *   - writes headers into empty Drafts/Sent/Undrafted tabs
 *   - adds the bot's extra columns (E1:G1) to the manual Recruiters List tab
 *
 * Safe to re-run: tabs that already contain data are left untouched.
 *
 *   npm run bootstrap-sheet            (uses the vikrant token by default)
 *   npm run bootstrap-sheet -- --profile <name>
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../src/config.js";
import { appendRows, ensureTabs, listTabs, readTab, updateRange } from "../src/google/sheets.js";
import { entryToRow, REGISTRY_COLUMNS } from "../src/registry/sheet-codec.js";
import { RegistryEntrySchema } from "../src/schemas.js";
import {
  DRAFTS_HEADER, RAW_DATA_HEADER, RECRUITERS_EXTRA_HEADER, SENT_HEADER, UNDRAFTED_HEADER,
} from "../src/outreach/tabs.js";
import { parseCsv } from "../eval/csv-parser.js";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function seedIfEmpty(
  profileId: string,
  tab: string,
  header: readonly string[],
  rows: string[][],
): Promise<void> {
  const existing = await readTab(profileId, tab);
  if (existing.length > 0) {
    console.log(`${tab}: already has ${existing.length} rows — untouched`);
    return;
  }
  await appendRows(profileId, tab, [[...header], ...rows]);
  console.log(`${tab}: wrote header + ${rows.length} rows`);
}

async function main(): Promise<void> {
  const profileId = argValue("--profile") ?? "vikrant";
  const t = config.google.tabs;

  const before = await listTabs(profileId);
  await ensureTabs(profileId, [t.rawData, t.drafts, t.sent, t.undrafted, t.companies]);
  console.log(`tabs before: ${before.join(" | ")}`);

  // Raw Data: the cleaned recruiter contact dump (local-only, never committed —
  // the live tab is the source once seeded, so a fresh clone skips this step).
  const csvPath = resolve(process.cwd(), "config/recruiters-raw.csv");
  if (existsSync(csvPath)) {
    const csvRows = parseCsv(readFileSync(csvPath, "utf-8").replace(/^﻿/, ""));
    const [csvHeader, ...contactRows] = csvRows;
    if (!csvHeader || csvHeader.join(",") !== RAW_DATA_HEADER.join(",")) {
      throw new Error(`config/recruiters-raw.csv header mismatch: ${(csvHeader ?? []).join(",")}`);
    }
    await seedIfEmpty(profileId, t.rawData, RAW_DATA_HEADER, contactRows);
  } else {
    console.log(`${t.rawData}: no local csv at ${csvPath} — leaving as-is`);
  }

  // Companies: seed from the local cache if one exists (e.g. a re-bootstrap
  // against a fresh spreadsheet). On a brand-new setup with no cache yet,
  // there is nothing to seed from — the tab starts empty and the user adds
  // rows by hand (the Companies tab is curated directly).
  const registryPath = resolve(process.cwd(), config.storage.registryPath);
  if (existsSync(registryPath)) {
    const entries = z.array(RegistryEntrySchema).parse(JSON.parse(readFileSync(registryPath, "utf-8")));
    await seedIfEmpty(profileId, t.companies, REGISTRY_COLUMNS, entries.map(entryToRow));
  } else {
    console.log(`${t.companies}: no local cache at ${registryPath} — leaving as-is`);
  }

  // Empty lifecycle tabs get their headers so humans see the schema immediately.
  await seedIfEmpty(profileId, t.drafts, DRAFTS_HEADER, []);
  await seedIfEmpty(profileId, t.sent, SENT_HEADER, []);
  await seedIfEmpty(profileId, t.undrafted, UNDRAFTED_HEADER, []);

  // Recruiters List: add the bot's E1:G1 columns once, never touch manual data.
  const recruiters = await readTab(profileId, t.recruiters);
  const headerRow = recruiters[0] ?? [];
  if ((headerRow[4] ?? "").trim() === "") {
    await updateRange(profileId, `${t.recruiters}!E1:G1`, [[...RECRUITERS_EXTRA_HEADER]]);
    console.log(`${t.recruiters}: added E1:G1 headers (${RECRUITERS_EXTRA_HEADER.join(", ")})`);
  } else {
    console.log(`${t.recruiters}: E1 already set ("${headerRow[4]}") — untouched`);
  }

  console.log("bootstrap complete");
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
