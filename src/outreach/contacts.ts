import { config } from "../config.js";
import { readTab as readTabDefault } from "../google/sheets.js";
import { upsertRecruiter } from "../db/recruiters.js";
import { normalizeCompanyName } from "./match.js";
import { RECRUITERS_LIST_COLS, RAW_DATA_COLS } from "./tabs.js";

export interface SyncContactsDeps {
  /** Injectable in tests to avoid a real Sheets fetch. */
  readTab?: (profileId: string, tab: string) => Promise<string[][]>;
}

/** Loose email check, good enough to drop junk cells without a full RFC5322 validator. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splits a cell that may hold multiple emails on '/' or ',', normalizes, drops non-emails. */
function splitEmails(cell: string): string[] {
  return cell
    .split(/[/,]/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
}

function cellAt(row: string[], index: number): string {
  return (row[index] ?? "").trim();
}

// Syncs recruiter contacts from two sheet tabs: "Raw Data" (unverified) synced first, then the
// manual "Recruiters List" (verified) so a contact in both ends up verified with the manual
// sheet's fields winning; upsertRecruiter's no-downgrade rule keeps a later re-sync from un-verifying.
export async function syncContactsFromSheet(
  profileId: string,
  deps: SyncContactsDeps = {},
): Promise<{ manual: number; raw: number }> {
  const readTab = deps.readTab ?? readTabDefault;
  const importedAt = new Date().toISOString();

  const rawRows = await readTab(profileId, config.google.tabs.rawData);
  let raw = 0;
  for (const row of rawRows.slice(1)) {
    const company = cellAt(row, RAW_DATA_COLS.company);
    const emails = splitEmails(cellAt(row, RAW_DATA_COLS.email));
    if (emails.length === 0) continue;
    const altNamesNorm =
      cellAt(row, RAW_DATA_COLS.altNames)
        .split(";")
        .map((a) => a.trim())
        .filter((a) => a.length > 0)
        .map((a) => normalizeCompanyName(a))
        .join(";") || null;
    const contactName = cellAt(row, RAW_DATA_COLS.contactName) || null;

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
    const company = cellAt(row, RECRUITERS_LIST_COLS.company);
    const emails = splitEmails(cellAt(row, RECRUITERS_LIST_COLS.email));
    if (emails.length === 0) continue;
    const contactName = cellAt(row, RECRUITERS_LIST_COLS.name) || null;
    const phone = cellAt(row, RECRUITERS_LIST_COLS.phone) || null;

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
