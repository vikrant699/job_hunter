// src/ats/keka.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeKeka, extractKekaOrgGuid } from "./keka.js";
import type { AdapterCompany } from "../types.js";

const company: AdapterCompany = {
  provider: "keka", slug: "mosaicwellness", name: "Mosaic Wellness",
  careersUrl: "https://mosaicwellness.keka.com/careers/", tenantUrl: null,
  apiMeta: { orgGuid: "fa11c430-c96c-447f-9f68-d05ab3867c12" },
};

const job = {
  id: 73091, title: "Data Analyst",
  description: "<p>Work with <strong>SQL</strong> and Power BI.</p>",
  jobLocations: [{ id: 617, name: "Thane", city: "Thane", state: "MH", countryCode: "IN", countryName: "India" }],
  jobNumber: "MW0400", publishedOn: "2026-05-25T13:14:15.897Z",
};

test("normalizeKeka maps fields, builds location and job URL", () => {
  const p = normalizeKeka(company, job);
  assert.equal(p.externalId, "73091");
  assert.equal(p.jobTitle, "Data Analyst");
  assert.equal(p.location, "Thane, MH, India");
  assert.equal(p.jobUrl, "https://mosaicwellness.keka.com/careers/jobdetails/73091");
  assert.match(p.jdText, /Work with SQL/);
  assert.equal(p.postedAt, "2026-05-25T13:14:15.897Z");
});

test("extractKekaOrgGuid pulls the first GUID from careers-page HTML", () => {
  const html = `<div data-org="fa11c430-c96c-447f-9f68-d05ab3867c12">x</div>`;
  assert.equal(extractKekaOrgGuid(html), "fa11c430-c96c-447f-9f68-d05ab3867c12");
  assert.equal(extractKekaOrgGuid("<div>no guid</div>"), null);
});
