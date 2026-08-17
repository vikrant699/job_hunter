import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBambooHr, buildBambooHrLocation, bambooHrListUrl, bambooHrDetailUrl, bambooHrJobUrl } from "../bamboohr.js";
import type { BambooHrJob } from "../bamboohr.js";
import type { AdapterCompany } from "../../types.js";

const company: AdapterCompany = {
  provider: "bamboohr",
  slug: "noorahealth",
  name: "Noora Health",
  careersUrl: "https://noorahealth.bamboohr.com/careers",
  tenantUrl: null,
  apiMeta: null,
};

// Realistic rows captured live from GET noorahealth.bamboohr.com/careers/list.
const jobLocationPopulated: BambooHrJob = {
  id: "105",
  jobOpeningName: "AI/ML Engineer",
  departmentLabel: "Engineering",
  employmentStatusLabel: "Full-Time",
  location: { city: "Bangalore", state: "Karnataka" },
  atsLocation: { country: null, state: null, province: null, city: null },
  isRemote: null,
  locationType: "2",
};

// location is null; real data lives in atsLocation, where city/state are swapped (a pincode sits in province, a state name in city).
const jobAtsLocationPopulated: BambooHrJob = {
  id: "144",
  jobOpeningName: "Program Officer",
  departmentLabel: "Program Delivery",
  employmentStatusLabel: "Fixed Term Employee",
  location: { city: null, state: null },
  atsLocation: { country: "India", state: null, province: "302001", city: "Rajasthan" },
  isRemote: null,
  locationType: "1",
};

const jobNoLocationData: BambooHrJob = {
  id: "999",
  jobOpeningName: "Ghost Role",
  departmentLabel: null,
  employmentStatusLabel: null,
  location: { city: null, state: null },
  atsLocation: { country: null, state: null, province: null, city: null },
  isRemote: null,
  locationType: null,
};

test("normalizeBambooHr prefers `location` when it has data", () => {
  const p = normalizeBambooHr(company, jobLocationPopulated);
  assert.equal(p.provider, "bamboohr");
  assert.equal(p.externalId, "105");
  assert.equal(p.jobTitle, "AI/ML Engineer");
  assert.equal(p.location, "Bangalore, Karnataka");
  assert.equal(p.jobUrl, "https://noorahealth.bamboohr.com/careers/105");
  assert.equal(p.jdText, "");
  assert.equal(p.postedAt, null);
});

test("normalizeBambooHr falls back to `atsLocation` when `location` is null", () => {
  const p = normalizeBambooHr(company, jobAtsLocationPopulated);
  assert.equal(p.externalId, "144");
  assert.equal(p.location, "Rajasthan, 302001, India");
  assert.equal(p.jobUrl, "https://noorahealth.bamboohr.com/careers/144");
});

test("normalizeBambooHr yields null location when both objects are empty", () => {
  const p = normalizeBambooHr(company, jobNoLocationData);
  assert.equal(p.location, null);
  assert.equal(p.isRemote, false);
});

test("buildBambooHrLocation joins only non-null parts, in order", () => {
  assert.equal(buildBambooHrLocation({ city: "Dhaka", state: null }, { country: null, state: null, province: null, city: null }), "Dhaka");
  assert.equal(buildBambooHrLocation({ city: null, state: null }, { country: "Bangladesh", state: null, province: null, city: "Chittagong" }), "Chittagong, Bangladesh");
  assert.equal(buildBambooHrLocation({ city: null, state: null }, { country: null, state: null, province: null, city: null }), null);
});

test("URL builders", () => {
  assert.equal(bambooHrListUrl("noorahealth"), "https://noorahealth.bamboohr.com/careers/list");
  assert.equal(bambooHrDetailUrl("noorahealth", "144"), "https://noorahealth.bamboohr.com/careers/144/detail");
  assert.equal(bambooHrJobUrl("noorahealth", "144"), "https://noorahealth.bamboohr.com/careers/144");
});
