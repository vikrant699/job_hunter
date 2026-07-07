import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyName, findContacts } from "./match.js";
import type { RecruiterRow } from "../db/recruiters.js";

/* ===== normalizeCompanyName ===== */

test("normalizeCompanyName strips legal suffixes and punctuation", () => {
  const cases: Array<[string, string]> = [
    ["Acelucid Technologies Private Limited", "acelucid technologies"],
    ["Bain & Company", "bain company"],
    ["PW (PhysicsWallah)", "pw physicswallah"],
    ["SNS Square Consultancy Services Pvt Ltd.", "sns square consultancy services"],
    ["Acme Inc", "acme"],
    ["Acme, Inc.", "acme"],
    ["Foo LLC", "foo"],
    ["Foo Corp", "foo"],
    ["Foo Corporation", "foo"],
    ["  Extra   Spaces   Ltd  ", "extra spaces"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeCompanyName(input), expected, `normalizeCompanyName(${input})`);
  }
});

test("normalizeCompanyName does not strip 'company'/'co' as a legal suffix", () => {
  assert.equal(normalizeCompanyName("Daniel P. O'Reilly and Company"), "daniel p o reilly and company");
});

test("normalizeCompanyName is idempotent", () => {
  const once = normalizeCompanyName("Acelucid Technologies Private Limited");
  assert.equal(normalizeCompanyName(once), once);
});

/* ===== findContacts ===== */

function mkRecruiter(overrides: Partial<RecruiterRow> = {}): RecruiterRow {
  return {
    email: "recruiter@acme.com",
    company: "Acme Inc",
    companyNorm: "acme",
    altNamesNorm: null,
    contactName: null,
    phone: null,
    source: "raw-csv",
    registryProvider: null,
    registrySlug: null,
    status: "unverified",
    verifiedAt: null,
    importedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-07-06T00:00:00.000Z").getTime();
const noDrafts = (): null => null;

test("tier c is EXACT-only: generic and substring domain labels never match (wrong-recipient guard)", () => {
  const cases: Array<[string, string]> = [
    // generic labels that substring-matched dozens of real registry companies
    ["Polygon Tech", "hr@tech-staffing.com"],
    ["AgNext Technologies", "jobs@tech.co.in"],
    ["Made In India Corp", "careers@india-jobs.com"],
    // short company name inside a longer domain label (the reverse direction)
    ["Axio", "people@axiomconsulting.com"],
    ["Meta", "talent@metadataworks.com"],
  ];
  for (const [companyName, email] of cases) {
    const result = findContacts({
      companyName,
      candidates: [mkRecruiter({ email, companyNorm: "something unrelated" })],
      lastDraftedAt: noDrafts,
      nowMs: NOW,
      cooldownDays: 30,
    });
    assert.equal(result.eligible.length, 0, `${companyName} must NOT match ${email}`);
    assert.equal(result.ineligible.length, 0);
  }
  // ...while the exact collapsed-name === label case still works.
  const exact = findContacts({
    companyName: "Adda247",
    candidates: [mkRecruiter({ email: "hr@adda247.com", companyNorm: "something unrelated" })],
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(exact.eligible.length, 1);
});

test("tier a: exact company_norm match", () => {
  const candidates = [mkRecruiter({ companyNorm: "acme" })];
  const result = findContacts({
    companyName: "Acme Inc",
    candidates,
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0]?.email, "recruiter@acme.com");
});

test("tier b: alt name match when exact company_norm doesn't match", () => {
  const candidates = [
    mkRecruiter({ companyNorm: "some-other-norm", altNamesNorm: "acelucid technologies;other-alt" }),
  ];
  const result = findContacts({
    companyName: "Acelucid Technologies Private Limited",
    candidates,
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 1);
});

test("tier c: email-domain heuristic when no exact/alt match, label >= 4 chars", () => {
  const candidates = [
    mkRecruiter({ email: "hr@adda247.com", companyNorm: "totally-different", altNamesNorm: null }),
  ];
  const result = findContacts({
    companyName: "Adda247",
    candidates,
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 1);
});

test("tier c guard: domain label shorter than 4 chars does not match", () => {
  const candidates = [
    mkRecruiter({ email: "hr@xyz.com", companyNorm: "totally-different", altNamesNorm: null }),
  ];
  const result = findContacts({
    companyName: "Xyz Global Corp",
    candidates,
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 0);
});

test("tier priority: exact match wins even if a different candidate would match by domain", () => {
  const exact = mkRecruiter({ email: "a@exact.com", companyNorm: "acme" });
  const domainOnly = mkRecruiter({ email: "b@acme.com", companyNorm: "unrelated" });
  const result = findContacts({
    companyName: "Acme Inc",
    candidates: [domainOnly, exact],
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 1);
  assert.equal(result.eligible[0]?.email, "a@exact.com");
});

test("no match across any tier yields empty eligible/ineligible", () => {
  const candidates = [mkRecruiter({ companyNorm: "nope", email: "x@nope.com" })];
  const result = findContacts({
    companyName: "Totally Unrelated Co",
    candidates,
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.ineligible.length, 0);
});

test("bounced matched contact is ineligible with reason bounced_contact", () => {
  const candidates = [mkRecruiter({ companyNorm: "acme", status: "bounced" })];
  const result = findContacts({
    companyName: "Acme Inc",
    candidates,
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.ineligible.length, 1);
  assert.equal(result.ineligible[0]?.reason, "bounced_contact");
});

test("matched contact drafted within cooldown window is ineligible with reason cooldown", () => {
  const email = "recruiter@acme.com";
  const candidates = [mkRecruiter({ email, companyNorm: "acme", status: "verified" })];
  const recentDraft = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
  const result = findContacts({
    companyName: "Acme Inc",
    candidates,
    lastDraftedAt: (e) => (e === email ? recentDraft : null),
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.ineligible.length, 1);
  assert.equal(result.ineligible[0]?.reason, "cooldown");
});

test("matched contact drafted exactly at the cooldown boundary is eligible (>= cooldownDays elapsed)", () => {
  const email = "recruiter@acme.com";
  const candidates = [mkRecruiter({ email, companyNorm: "acme" })];
  const exactlyThirtyDaysAgo = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = findContacts({
    companyName: "Acme Inc",
    candidates,
    lastDraftedAt: (e) => (e === email ? exactlyThirtyDaysAgo : null),
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.eligible.length, 1);
});

test("bounced beats cooldown when both would apply: reported as bounced_contact", () => {
  const email = "recruiter@acme.com";
  const candidates = [mkRecruiter({ email, companyNorm: "acme", status: "bounced" })];
  const recentDraft = new Date(NOW - 1000).toISOString();
  const result = findContacts({
    companyName: "Acme Inc",
    candidates,
    lastDraftedAt: (e) => (e === email ? recentDraft : null),
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.equal(result.ineligible.length, 1);
  assert.equal(result.ineligible[0]?.reason, "bounced_contact");
});

test("eligible ordering: verified before unverified", () => {
  const unverified = mkRecruiter({ email: "u@acme.com", companyNorm: "acme", status: "unverified" });
  const verified = mkRecruiter({ email: "v@acme.com", companyNorm: "acme", status: "verified" });
  const result = findContacts({
    companyName: "Acme Inc",
    candidates: [unverified, verified],
    lastDraftedAt: noDrafts,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.deepEqual(result.eligible.map((r) => r.email), ["v@acme.com", "u@acme.com"]);
});

test("eligible ordering: within same status, least-recently-drafted first, never-drafted (null) first", () => {
  const never = mkRecruiter({ email: "never@acme.com", companyNorm: "acme", status: "verified" });
  const oldDraft = mkRecruiter({ email: "old@acme.com", companyNorm: "acme", status: "verified" });
  const recentDraft = mkRecruiter({ email: "recent@acme.com", companyNorm: "acme", status: "verified" });
  const drafted: Record<string, string> = {
    "old@acme.com": new Date(NOW - 200 * 24 * 60 * 60 * 1000).toISOString(),
    "recent@acme.com": new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const result = findContacts({
    companyName: "Acme Inc",
    candidates: [recentDraft, never, oldDraft],
    lastDraftedAt: (e) => drafted[e] ?? null,
    nowMs: NOW,
    cooldownDays: 30,
  });
  assert.deepEqual(result.eligible.map((r) => r.email), ["never@acme.com", "old@acme.com", "recent@acme.com"]);
});
