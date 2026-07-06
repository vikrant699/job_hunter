import { test } from "node:test";
import assert from "node:assert/strict";
import { syncContactsFromSheet } from "./contacts.js";
import { selectAllRecruiters, setRecruiterStatus } from "../db/recruiters.js";
import { config } from "../config.js";

function mkReadTab(tabs: Record<string, string[][]>) {
  return async (_profileId: string, tab: string): Promise<string[][]> => tabs[tab] ?? [];
}

function uniqueEmail(tag: string): string {
  return `sync-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

test("syncContactsFromSheet imports manual-sheet rows as verified with company_norm + phone/name", async () => {
  const email = uniqueEmail("manual");
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [
      ["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"],
      ["Acme Private Limited", "Jane Doe", "12345", email, "", "", ""],
    ],
    [config.google.tabs.rawData]: [["company", "email", "contact_name", "alt_names", "flags", "seen"]],
  });

  const result = await syncContactsFromSheet("default", { readTab });
  assert.equal(result.manual, 1);
  assert.equal(result.raw, 0);

  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "verified");
  assert.equal(row.source, "manual-sheet");
  assert.equal(row.companyNorm, "acme");
  assert.equal(row.contactName, "Jane Doe");
  assert.equal(row.phone, "12345");
});

test("syncContactsFromSheet splits multiple emails in one cell on '/' and ','", async () => {
  const emailA = uniqueEmail("multi-a");
  const emailB = uniqueEmail("multi-b");
  const emailC = uniqueEmail("multi-c");
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [
      ["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"],
      ["Multi Co", "Team", "", `${emailA}/${emailB}, ${emailC}`, "", "", ""],
    ],
    [config.google.tabs.rawData]: [["company", "email", "contact_name", "alt_names", "flags", "seen"]],
  });

  const result = await syncContactsFromSheet("default", { readTab });
  assert.equal(result.manual, 3);

  const all = selectAllRecruiters();
  for (const email of [emailA, emailB, emailC]) {
    assert.ok(all.some((r) => r.email === email), `expected ${email} to be imported`);
  }
});

test("syncContactsFromSheet drops invalid email cells and skips phone-only rows with no valid email", async () => {
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [
      ["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"],
      ["No Email Co", "Ghost", "99999", "", "", "", ""],
      ["Bad Email Co", "Ghost2", "", "not-an-email", "", "", ""],
      ["  ", "  ", "", "   ", "", "", ""],
    ],
    [config.google.tabs.rawData]: [["company", "email", "contact_name", "alt_names", "flags", "seen"]],
  });

  const result = await syncContactsFromSheet("default", { readTab });
  assert.equal(result.manual, 0);
  assert.equal(result.raw, 0);
});

test("syncContactsFromSheet imports raw-csv rows as unverified with alt_names_norm joined", async () => {
  const email = uniqueEmail("raw");
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"]],
    [config.google.tabs.rawData]: [
      ["company", "email", "contact_name", "alt_names", "flags", "seen"],
      ["Beta Pvt Ltd", email, "Bob", "Beta Technologies;Beta Tech Pvt Ltd", "", ""],
    ],
  });

  const result = await syncContactsFromSheet("default", { readTab });
  assert.equal(result.raw, 1);
  assert.equal(result.manual, 0);

  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "unverified");
  assert.equal(row.source, "raw-csv");
  assert.equal(row.companyNorm, "beta");
  assert.equal(row.altNamesNorm, "beta technologies;beta tech");
});

test("syncContactsFromSheet dedups across tabs: manual wins and never downgrades an existing verified/bounced status", async () => {
  const email = uniqueEmail("dedup");
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [
      ["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"],
      ["Gamma Inc", "Gina", "555", email, "", "", ""],
    ],
    [config.google.tabs.rawData]: [
      ["company", "email", "contact_name", "alt_names", "flags", "seen"],
      ["Gamma Inc", email, "Gina Raw", "", "", ""],
    ],
  });

  const result = await syncContactsFromSheet("default", { readTab });
  assert.equal(result.manual, 1);
  assert.equal(result.raw, 1);

  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  // manual-sheet (verified) processed after raw-csv (unverified) must win.
  assert.equal(row.status, "verified");
  assert.equal(row.source, "manual-sheet");
});

test("re-sync never un-verifies or wipes verified_at for a contact already marked verified/bounced", async () => {
  const email = uniqueEmail("preserve");
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"]],
    [config.google.tabs.rawData]: [
      ["company", "email", "contact_name", "alt_names", "flags", "seen"],
      ["Delta Co", email, "Dan", "", "", ""],
    ],
  });

  await syncContactsFromSheet("default", { readTab });
  const bouncedAt = new Date().toISOString();
  setRecruiterStatus(email, "bounced", bouncedAt);

  // Re-sync from the same raw-csv source (still 'unverified' proposal).
  await syncContactsFromSheet("default", { readTab });

  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "bounced");
});

test("syncContactsFromSheet returns 0/0 for header-only tabs", async () => {
  const readTab = mkReadTab({
    [config.google.tabs.recruiters]: [["Company", "Name", "Phone", "Email", "Source", "Verified On", "Registry Slug"]],
    [config.google.tabs.rawData]: [["company", "email", "contact_name", "alt_names", "flags", "seen"]],
  });

  const result = await syncContactsFromSheet("default", { readTab });
  assert.equal(result.manual, 0);
  assert.equal(result.raw, 0);
});
