// src/ats/reliancebrands.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReliance } from "./reliancebrands.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "reliancebrands",
  slug: "reliance-brands",
  name: "Reliance Brands",
  careersUrl: "https://rblcareers.in",
  tenantUrl: "https://peoplefirst.ril.com/ocandidate/#/rbl-home",
  apiMeta: null,
};

test("normalizeReliance maps via candidate keys and strips JD HTML", () => {
  const p = normalizeReliance(company, {
    JobTitle: "Store Manager",
    ReqId: "RB-1001",
    City: "Mumbai",
    JobDescription: "<p>Run the store.</p>",
    PostedDate: "2026-07-10",
  })!;
  assert.equal(p.externalId, "RB-1001");
  assert.equal(p.jobTitle, "Store Manager");
  assert.equal(p.location, "Mumbai");
  assert.equal(p.jdText, "Run the store.");
  assert.equal(p.postedAt, "2026-07-10");
});

test("normalizeReliance tolerates lowercase/alternate key names", () => {
  const p = normalizeReliance(company, { positionName: "Visual Merchandiser", jobId: 42, location: "Delhi", description: "Style displays." })!;
  assert.equal(p.jobTitle, "Visual Merchandiser");
  assert.equal(p.externalId, "42");
  assert.equal(p.location, "Delhi");
  assert.equal(p.jdText, "Style displays.");
});

test("normalizeReliance returns null when no title-like field is present", () => {
  assert.equal(normalizeReliance(company, { foo: "bar", City: "Mumbai" }), null);
});

test("normalizeReliance falls back to a title slug id when no id field", () => {
  const p = normalizeReliance(company, { title: "Area Sales Lead (West)" })!;
  assert.equal(p.externalId, "area-sales-lead-west-");
});
