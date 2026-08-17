import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertRecruiter,
  selectAllRecruiters,
  selectRecruitersByCompanyNorm,
  setRecruiterStatus,
} from "../recruiters.js";

function mkEmail(tag: string): string {
  return `recruiter-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

test("upsertRecruiter inserts a new row with defaults", () => {
  const email = mkEmail("new");
  upsertRecruiter({
    email,
    company: "Acme Inc",
    companyNorm: "acme",
    altNamesNorm: null,
    contactName: "Jane Doe",
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });
  const all = selectAllRecruiters();
  const row = all.find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.company, "Acme Inc");
  assert.equal(row.status, "unverified");
  assert.equal(row.verifiedAt, null);
});

test("upsertRecruiter does not downgrade an existing verified status on re-import", () => {
  const email = mkEmail("no-downgrade");
  const verifiedAt = new Date().toISOString();
  upsertRecruiter({
    email,
    company: "Acme Inc",
    companyNorm: "acme",
    altNamesNorm: null,
    contactName: "Jane Doe",
    phone: null,
    source: "manual-sheet",
    registryProvider: null,
    registrySlug: null,
    status: "verified",
    verifiedAt,
    importedAt: new Date().toISOString(),
  });

  // Re-import from raw-csv (status unverified) should NOT clobber verified.
  upsertRecruiter({
    email,
    company: "Acme Inc (renamed)",
    companyNorm: "acme renamed",
    altNamesNorm: null,
    contactName: "Jane D.",
    phone: "12345",
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });

  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "verified");
  assert.equal(row.verifiedAt, verifiedAt);
  // non-status fields DO get refreshed by the re-import
  assert.equal(row.company, "Acme Inc (renamed)");
  assert.equal(row.phone, "12345");
});

test("upsertRecruiter allows an explicit upgrade (unverified -> verified) via re-import", () => {
  const email = mkEmail("upgrade");
  upsertRecruiter({
    email,
    company: "Beta Co",
    companyNorm: "beta",
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });
  const verifiedAt = new Date().toISOString();
  upsertRecruiter({
    email,
    company: "Beta Co",
    companyNorm: "beta",
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "manual-sheet",
    registryProvider: null,
    registrySlug: null,
    status: "verified",
    verifiedAt,
    importedAt: new Date().toISOString(),
  });
  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "verified");
  assert.equal(row.verifiedAt, verifiedAt);
});

test("upsertRecruiter does not resurrect a bounced contact via unverified re-import", () => {
  const email = mkEmail("bounced");
  upsertRecruiter({
    email,
    company: "Gamma LLC",
    companyNorm: "gamma",
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });
  setRecruiterStatus(email, "bounced", new Date().toISOString());

  upsertRecruiter({
    email,
    company: "Gamma LLC",
    companyNorm: "gamma",
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });

  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "bounced");
});

test("selectRecruitersByCompanyNorm filters to the given normalized company", () => {
  const norm = `norm-${Date.now()}`;
  const emailA = mkEmail("company-a");
  const emailB = mkEmail("company-b");
  upsertRecruiter({
    email: emailA,
    company: "Foo",
    companyNorm: norm,
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });
  upsertRecruiter({
    email: emailB,
    company: "Bar",
    companyNorm: `other-${Date.now()}`,
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });

  const rows = selectRecruitersByCompanyNorm(norm);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.email, emailA);
});

test("setRecruiterStatus sets verified_at only when status is verified", () => {
  const email = mkEmail("set-status");
  upsertRecruiter({
    email,
    company: "Delta",
    companyNorm: "delta",
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: new Date().toISOString(),
  });

  const verifiedAt = new Date().toISOString();
  setRecruiterStatus(email, "verified", verifiedAt);
  let row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "verified");
  assert.equal(row.verifiedAt, verifiedAt);

  // Transition to bounced: verified_at is untouched since the function only stamps it for 'verified'.
  setRecruiterStatus(email, "bounced", new Date().toISOString());
  row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "bounced");
});

test("setRecruiterStatus refuses bounced -> verified (dead is dead)", () => {
  const email = `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  upsertRecruiter({
    email, company: "Dead Co", companyNorm: "dead", altNamesNorm: null,
    contactName: null, phone: null, source: "raw-csv", registryProvider: null,
    registrySlug: null, status: "unverified", verifiedAt: null,
    importedAt: new Date().toISOString(),
  });
  setRecruiterStatus(email, "bounced", new Date().toISOString());
  setRecruiterStatus(email, "verified", new Date().toISOString());
  const row = selectAllRecruiters().find((r) => r.email === email);
  assert.ok(row);
  assert.equal(row.status, "bounced");
});
