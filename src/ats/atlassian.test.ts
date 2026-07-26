// src/ats/atlassian.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAtlassianListings, normalizeAtlassian, atlassianJdText, AtlassianJobSchema } from "./atlassian.js";
import type { AdapterCompany } from "../types.js";
import { at } from "./test-helpers.js";

const company: AdapterCompany = {
  provider: "atlassian",
  slug: "atlassian",
  name: "Atlassian",
  careersUrl: "https://www.atlassian.com/company/careers",
  tenantUrl: null,
  apiMeta: null,
};

const listing = [
  {
    portalJobPost: {
      portalId: 17,
      portalUrl: "https://careers-apac-atlassian.icims.com/jobs/25020/account-executive/job",
      id: 25020,
      updatedDate: "2026-06-30 07:30 PM",
    },
    id: 25020,
    portalId: 17,
    title: "Account Executive, Enterprise",
    locations: ["Bengaluru - India -   Bengaluru,  560071 India", "Remote - Remote"],
    category: "Sales",
    overview: "<p>At Atlassian, we <b>unleash</b> teams.</p>",
    responsibilities: "<ul><li>Develop territory plans</li></ul>",
    qualifications: "<p>Experience managing key accounts</p>",
    applyUrl: "https://careers-apac-atlassian.icims.com/jobs/25020/account-executive%2c-enterprise/login",
  },
  { junk: true }, // malformed entries are skipped, not fatal
];

test("parseAtlassianListings keeps valid entries and skips malformed ones", () => {
  const jobs = parseAtlassianListings(listing);
  assert.equal(jobs.length, 1);
  assert.equal(at(jobs, 0).title, "Account Executive, Enterprise");
});

test("atlassianJdText joins the three HTML JD fields into plain text", () => {
  const j = AtlassianJobSchema.parse(listing[0]);
  const jd = atlassianJdText(j);
  assert.match(jd, /unleash teams/);
  assert.match(jd, /Develop territory plans/);
  assert.match(jd, /managing key accounts/);
  assert.doesNotMatch(jd, /<p>/);
});

test("normalizeAtlassian maps fields", () => {
  const j = AtlassianJobSchema.parse(listing[0]);
  const p = normalizeAtlassian(company, j);
  assert.equal(p.provider, "atlassian");
  assert.equal(p.externalId, "25020");
  assert.equal(p.jobUrl, "https://careers-apac-atlassian.icims.com/jobs/25020/account-executive/job");
  assert.equal(p.location, "Bengaluru - India -   Bengaluru,  560071 India; Remote - Remote");
  assert.equal(p.isRemote, true);
  assert.ok(p.jdText.length > 50);
  assert.equal(p.postedAt, "2026-06-30 07:30 PM");
});

test("parseAtlassianListings throws on a non-array payload", () => {
  assert.throws(() => parseAtlassianListings({ jobs: [] }));
});
