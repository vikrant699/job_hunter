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

// A bare ISO country code is what the jobSearch filter itself sends
// (`{match:{Country:"IN"}}`), so it is the most likely country value to come
// back. Emitting the raw "IN" as the location made the pipeline's strict
// checkLocation() drop the posting — the profile's country hints are "india" /
// "in," and neither matches "in" — so an India-only req would be discarded as
// out-of-region. Expanding the code keeps it in.
test("normalizeReliance expands a bare country code so it carries geo signal", () => {
  const p = normalizeReliance(company, { title: "Buyer", Country: "IN" })!;
  assert.equal(p.location, "India");
});

test("normalizeReliance appends the country to a city so both signals survive", () => {
  const p = normalizeReliance(company, { title: "Buyer", City: "Mumbai", Country: "IN" })!;
  assert.equal(p.location, "Mumbai, India");
});

test("normalizeReliance does not duplicate a country already named in the city field", () => {
  const p = normalizeReliance(company, { title: "Buyer", Location: "Mumbai, India", country: "India" })!;
  assert.equal(p.location, "Mumbai, India");
});

test("normalizeReliance leaves an unrecognized country code alone rather than guessing", () => {
  const p = normalizeReliance(company, { title: "Buyer", Country: "AE" })!;
  assert.equal(p.location, "AE");
});

test("normalizeReliance yields a null location when no location field is present", () => {
  const p = normalizeReliance(company, { title: "Buyer" })!;
  assert.equal(p.location, null);
});
