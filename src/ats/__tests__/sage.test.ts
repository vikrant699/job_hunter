import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSage, filterIndiaSage, SageRecordSchema } from "../sage.js";
import type { SageRecord } from "../sage.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "sage",
  slug: "sage",
  name: "Sage (incl. Fyle)",
  careersUrl: "https://www.sage.com/en-gb/company/careers/",
  tenantUrl: null,
  apiMeta: null,
};

// Real record from Sage's CareerSearch API - an ex-Fyle Bangalore role, JD still mentions Fyle post-acquisition.
const fyleRecord: SageRecord = {
  Id: "VN33156",
  Name: "Frontend Architect",
  Function: "Product Delivery",
  Description:
    "About Fyle (now part of Sage) \r\nFyle is now part of Sage, a global leader in accounting and business management software. Together, we’re building a global expense management solution.",
  Url: "https://sagehr.my.salesforce-sites.com/careers/fRecruit__ApplyJob?vacancyNo=VN33156",
  OfficeLocation: "Bangalore",
  Country: "India",
  ActiveDate: "2025-09-08",
};

const usRecord: SageRecord = {
  Id: "VN42614",
  Name: "Sales Excellence Graduate-Atlanta",
  Function: "Sales",
  Description: "At Sage, innovation starts with our people.",
  Url: "https://sagehr.my.salesforce-sites.com/careers/fRecruit__ApplyJob?vacancyNo=VN42614",
  OfficeLocation: "Atlanta",
  Country: "United States",
  ActiveDate: "2026-07-10",
};

test("SageRecordSchema accepts the real shape and tolerates missing optionals", () => {
  assert.ok(SageRecordSchema.safeParse(fyleRecord).success);
  assert.ok(SageRecordSchema.safeParse({ Id: "x", Name: "y", Url: "https://x" }).success);
  assert.equal(SageRecordSchema.safeParse({ Name: "no id" }).success, false);
});

test("filterIndiaSage keeps only Country === India (case-insensitive)", () => {
  const kept = filterIndiaSage([fyleRecord, usRecord, { ...fyleRecord, Country: "india" }]);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((r) => r.Id === "VN33156"));
});

test("filterIndiaSage drops records with a missing/null Country", () => {
  const kept = filterIndiaSage([{ ...fyleRecord, Country: null }]);
  assert.equal(kept.length, 0);
});

test("normalizeSage maps fields, uses OfficeLocation, and passes the description through verbatim (already plain text)", () => {
  const p = normalizeSage(company, fyleRecord);
  assert.equal(p.provider, "sage");
  assert.equal(p.externalId, "VN33156");
  assert.equal(p.jobTitle, "Frontend Architect");
  assert.equal(p.jobUrl, "https://sagehr.my.salesforce-sites.com/careers/fRecruit__ApplyJob?vacancyNo=VN33156");
  assert.equal(p.location, "Bangalore");
  assert.equal(p.isRemote, false);
  assert.match(p.jdText, /Fyle is now part of Sage/);
  assert.equal(p.postedAt, new Date("2025-09-08").toISOString());
});

test("normalizeSage falls back to null location when OfficeLocation is absent", () => {
  const p = normalizeSage(company, { ...fyleRecord, OfficeLocation: null });
  assert.equal(p.location, null);
});

test("normalizeSage detects remote from the location string", () => {
  const p = normalizeSage(company, { ...fyleRecord, OfficeLocation: "India - Remote" });
  assert.equal(p.isRemote, true);
});

test("normalizeSage maps an unparseable ActiveDate to null", () => {
  const p = normalizeSage(company, { ...fyleRecord, ActiveDate: "not-a-date" });
  assert.equal(p.postedAt, null);
});
