import { config } from "../config.js";
import { readTab as readTabDefault } from "../google/sheets.js";
import { upsertRecruiter } from "../db/recruiters.js";
import { normalizeCompanyName } from "./match.js";

export interface SyncContactsDeps {
  /** Injectable in tests to avoid a real Sheets fetch. Defaults to the real
   *  Google Sheets client's readTab. */
  readTab?: (profileId: string, tab: string) => Promise<string[][]>;
}

/** Very small validity check: something@something.something. Good enough to
 *  drop obvious junk cells without pulling in a full RFC5322 validator. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splits a cell that may hold multiple emails on '/' or ',', trims, lowercases,
 *  and drops anything that doesn't look like an email. */
function splitEmails(cell: string): string[] {
  return cell
    .split(/[/,]/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
}

const RECRUITERS_COL = {
  company: 0,
  name: 1,
  phone: 2,
  email: 3,
} as const;

const RAW_DATA_COL = {
  company: 0,
  email: 1,
  contactName: 2,
  altNames: 3,
} as const;

function cellAt(row: string[], index: number): string {
  return (row[index] ?? "").trim();
}

/**
 * Syncs recruiter contacts into the DB from the two Google Sheet tabs that
 * feed outreach: the manually-maintained "Recruiters List" tab (grandfathered
 * as verified) and the bot-owned "Raw Data" tab (unverified until a real
 * outreach round-trip proves the address). Upsert order is raw-csv FIRST,
 * manual-sheet SECOND, so a contact present in both tabs ends up verified with
 * the manual sheet's company/name/phone winning (upsertRecruiter's no-downgrade
 * rule guarantees this never un-verifies or wipes verified_at on a later
 * re-sync, since a plain re-import always proposes 'unverified' or 'verified',
 * never 'bounced').
 */
export async function syncContactsFromSheet(
  profileId: string,
  deps: SyncContactsDeps = {},
): Promise<{ manual: number; raw: number }> {
  const readTab = deps.readTab ?? readTabDefault;
  const importedAt = new Date().toISOString();

  const rawRows = await readTab(profileId, config.google.tabs.rawData);
  let raw = 0;
  for (const row of rawRows.slice(1)) {
    const company = cellAt(row, RAW_DATA_COL.company);
    const emails = splitEmails(cellAt(row, RAW_DATA_COL.email));
    if (emails.length === 0) continue;
    const altNamesNorm =
      cellAt(row, RAW_DATA_COL.altNames)
        .split(";")
        .map((a) => a.trim())
        .filter((a) => a.length > 0)
        .map((a) => normalizeCompanyName(a))
        .join(";") || null;
    const contactName = cellAt(row, RAW_DATA_COL.contactName) || null;

    for (const email of emails) {
      upsertRecruiter({
        email,
        company,
        companyNorm: normalizeCompanyName(company),
        altNamesNorm,
        contactName,
        phone: null,
        source: "raw-csv",
        registryProvider: null,
        registrySlug: null,
        status: "unverified",
        verifiedAt: null,
        importedAt,
      });
      raw++;
    }
  }

  const recruiterRows = await readTab(profileId, config.google.tabs.recruiters);
  let manual = 0;
  const verifiedAt = importedAt;
  for (const row of recruiterRows.slice(1)) {
    const company = cellAt(row, RECRUITERS_COL.company);
    const emails = splitEmails(cellAt(row, RECRUITERS_COL.email));
    if (emails.length === 0) continue;
    const contactName = cellAt(row, RECRUITERS_COL.name) || null;
    const phone = cellAt(row, RECRUITERS_COL.phone) || null;

    for (const email of emails) {
      upsertRecruiter({
        email,
        company,
        companyNorm: normalizeCompanyName(company),
        altNamesNorm: null,
        contactName,
        phone,
        source: "manual-sheet",
        registryProvider: null,
        registrySlug: null,
        status: "verified",
        verifiedAt,
        importedAt,
      });
      manual++;
    }
  }

  return { manual, raw };
}
